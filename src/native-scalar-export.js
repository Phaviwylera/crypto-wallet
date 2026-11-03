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
  onProgress = () => {},
  showSaveFilePicker,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const total = Number(expectedBytes);
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error('The expected export size must be a positive integer before saving the TXT.');
  }
  if (typeof showSaveFilePicker !== 'function') {
    throw new Error('This browser cannot stream an authenticated large download. Use a current Chromium browser or the native CLI instead.');
  }
  // The picker must be invoked from the user's click before any network await.
  const handle = await showSaveFilePicker({
    suggestedName,
    types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
  });
  let writable;
  let writer;
  let reader;
  let closed = false;
  try {
    // Chromium stages writes in a temporary .crswap file. The chosen TXT stays
    // empty until close() succeeds; do not report success before that commit.
    writable = await handle.createWritable({ keepExistingData: false });
    writer = writable.getWriter();
    const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const response = await fetchImpl(`/api/native-scalar-export/download?id=${encodeURIComponent(jobId)}`, {
      cache: 'no-store',
      headers,
    });
    if (!response.ok) throw await responseError(response, 'Native scalar download failed');
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'text/plain') {
      throw new Error('The server did not return a text/plain TXT export. No download was saved.');
    }
    if (!response.body) throw new Error('The browser did not provide a readable download stream.');
    const encoding = (response.headers.get('content-encoding') || 'identity').trim().toLowerCase();
    const contentLength = response.headers.get('content-length');
    // Content-Length describes compressed bytes for gzip/br responses. The
    // decompressed byte count below must always match the completed job size.
    if ((!encoding || encoding === 'identity') && contentLength !== null && Number(contentLength) !== total) {
      throw new Error(`Download Content-Length is ${contentLength}, but the completed export requires ${total} bytes.`);
    }

    reader = response.body.getReader();
    let completed = 0;
    // Await each write for disk backpressure. Only one network chunk is held;
    // neither a whole-file Blob nor a second in-memory copy of the TXT is used.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('The download stream returned invalid byte data.');
      if (completed + value.byteLength > total) {
        throw new Error('The download is larger than expected. The incomplete TXT was not saved.');
      }
      await writer.write(value);
      completed += value.byteLength;
      onProgress({ phase: 'writing', completed, total });
    }
    if (completed === 0) throw new Error('The server returned an empty download. No TXT was saved.');
    if (completed !== total) {
      throw new Error(`Download incomplete: received ${completed} of ${total} bytes. Retry while the server copy is available.`);
    }

    onProgress({ phase: 'finalizing', completed, total });
    // Explicitly commit and flush the browser's staging file. Merely receiving
    // the last network chunk does not mean the destination TXT is ready.
    await writer.close();
    closed = true;
    const savedFile = await handle.getFile();
    if (savedFile.size !== total) {
      throw new Error(`The saved file has ${savedFile.size} bytes; expected ${total}. Do not use this incomplete TXT; retry the download.`);
    }
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
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch { /* The stream may already be released. */ }
    try { writer?.releaseLock(); } catch { /* Closing releases the writer automatically. */ }
  }
}
