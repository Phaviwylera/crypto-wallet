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
  showSaveFilePicker,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  if (typeof showSaveFilePicker !== 'function') {
    throw new Error('This browser cannot stream an authenticated large download. Use a current Chromium browser or the native CLI instead.');
  }
  // The picker must be invoked from the user's click before any network await.
  const handle = await showSaveFilePicker({
    suggestedName,
    types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
  });
  const writable = await handle.createWritable();
  try {
    const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const response = await fetchImpl(`/api/native-scalar-export/download?id=${encodeURIComponent(jobId)}`, {
      cache: 'no-store',
      headers,
    });
    if (!response.ok) throw await responseError(response, 'Native scalar download failed');
    if (!response.body) throw new Error('The browser did not provide a readable download stream.');
    // Pipe directly to the destination file; never create a whole-file Blob.
    await response.body.pipeTo(writable);
  } catch (error) {
    try { await writable.abort(); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
