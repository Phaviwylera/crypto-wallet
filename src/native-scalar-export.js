import { createExportFileHandle, ensureExportFolderPermission } from './download-folder.js';
import { normalizeScalarExportFormat, scalarExportFileTypes, SCALAR_EXPORT_FORMATS } from './scalar-export-format.js';

async function responseError(response, fallback) {
  const data = await response.json().catch(() => null);
  return new Error(data?.error || `${fallback} (HTTP ${response.status})`);
}

export async function nativeScalarExportRequest(action, {
  method = 'GET',
  body,
  id = '',
  accessToken = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const query = id ? `?id=${encodeURIComponent(id)}` : '';
  const response = await fetchImpl(`/api/native-scalar-export/${action}${query}`, {
    method,
    cache: 'no-store',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await responseError(response, 'Native scalar export failed');
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('Native scalar export returned an invalid response.');
  return data;
}

export async function streamNativeScalarExportDownload({
  jobId,
  accessToken = '',
  suggestedName,
  expectedBytes,
  format = 'txt',
  onProgress = () => {},
  directoryHandle,
  showSaveFilePicker,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const exportFormat = normalizeScalarExportFormat(format);
  const { label, mimeType, extension } = SCALAR_EXPORT_FORMATS[exportFormat];
  const total = Number(expectedBytes);
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`The expected export size must be a positive integer before saving the ${label}.`);
  }
  if (suggestedName !== undefined && (typeof suggestedName !== 'string' || !suggestedName.toLowerCase().endsWith(`.${extension}`))) {
    throw new Error(`The ${label} download file name must end in .${extension}.`);
  }
  // A previously chosen folder still needs write permission, and the browser
  // may only grant it inside this download click. Do this before any network
  // await, but delay creating the destination file until the response headers
  // validate so an HTTP/error response does not leave an empty export behind.
  let handle;
  if (directoryHandle) {
    await ensureExportFolderPermission(directoryHandle);
  } else {
    if (typeof showSaveFilePicker !== 'function') {
      throw new Error('This browser cannot stream an authenticated large download. Use a current Chromium browser or the native CLI instead.');
    }
    handle = await showSaveFilePicker({ suggestedName, types: scalarExportFileTypes(exportFormat) });
  }
  let writable;
  let writer;
  let reader;
  let closed = false;
  let verified = false;
  try {
    if (!directoryHandle) {
      // Chromium stages writes in a temporary .crswap file. The chosen file stays
      // empty until close() succeeds; do not report success before that commit.
      writable = await handle.createWritable({ keepExistingData: false });
      writer = writable.getWriter();
    }
    const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const formatQuery = exportFormat === 'txt' ? '' : `&format=${exportFormat}`;
    const response = await fetchImpl(`/api/native-scalar-export/download?id=${encodeURIComponent(jobId)}${formatQuery}`, {
      cache: 'no-store',
      headers,
    });
    if (!response.ok) throw await responseError(response, 'Native scalar download failed');
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== mimeType) {
      throw new Error(`The server did not return a ${mimeType} ${label} export. No download was saved.`);
    }
    if (!response.body) throw new Error('The browser did not provide a readable download stream.');
    const encoding = (response.headers.get('content-encoding') || 'identity').trim().toLowerCase();
    const contentLength = response.headers.get('content-length');
    // Content-Length describes compressed bytes for gzip/br responses. The
    // decompressed byte count below must always match the completed job size.
    if ((!encoding || encoding === 'identity') && contentLength !== null && Number(contentLength) !== total) {
      throw new Error(`Download Content-Length is ${contentLength}, but the completed export requires ${total} bytes.`);
    }

    if (directoryHandle) {
      // Permission was already requested inside the download click. Create the
      // no-clobber destination only after the response headers are known good.
      handle = await createExportFileHandle(directoryHandle, suggestedName, { ensurePermission: false });
      writable = await handle.createWritable({ keepExistingData: false });
      writer = writable.getWriter();
    }

    reader = response.body.getReader();
    let completed = 0;
    // Await each write for disk backpressure. Only one network chunk is held;
    // neither a whole-file Blob nor a second in-memory copy of the export is used.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('The download stream returned invalid byte data.');
      if (completed + value.byteLength > total) {
        throw new Error(`The download is larger than expected. The incomplete ${label} was not saved.`);
      }
      await writer.write(value);
      completed += value.byteLength;
      onProgress({ phase: 'writing', completed, total });
    }
    if (completed === 0) throw new Error(`The server returned an empty download. No ${label} was saved.`);
    if (completed !== total) {
      throw new Error(`Download incomplete: received ${completed} of ${total} bytes. Retry while the server copy is available.`);
    }

    onProgress({ phase: 'finalizing', completed, total });
    // Explicitly commit and flush the browser's staging file. Merely receiving
    // the last network chunk does not mean the destination file is ready.
    await writer.close();
    closed = true;
    const savedFile = await handle.getFile();
    if (savedFile.size !== total) {
      throw new Error(`The saved file has ${savedFile.size} bytes; expected ${total}. Do not use this incomplete ${label}; retry the download.`);
    }
    verified = true;
    onProgress({ phase: 'verified', completed, total });
    return { bytes: savedFile.size, fileName: handle.name };
  } catch (error) {
    // Stop an in-flight network response and discard the staging file on any
    // pre-commit failure. Cleanup must not replace the useful original error.
    if (reader) {
      try { await reader.cancel(error); } catch { /* Already closed or errored. */ }
    }
    if (writer && !closed) {
      try { await writer.abort(error); } catch { /* Already closed or aborted. */ }
    }
    if (directoryHandle && handle && !verified) {
      // The folder path created a fresh no-clobber file name. Remove an empty
      // or incomplete destination so a failed download does not look usable.
      try { await directoryHandle.removeEntry(handle.name); } catch { /* Best effort. */ }
    }
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch { /* The stream may already be released. */ }
    try { writer?.releaseLock(); } catch { /* Closing releases the writer automatically. */ }
  }
}
