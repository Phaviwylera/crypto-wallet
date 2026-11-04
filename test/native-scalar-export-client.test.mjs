import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeScalarExportRequest, streamNativeScalarExportDownload } from '../src/native-scalar-export.js';

// Model the save picker's staging file: writes are not visible in the chosen
// TXT until close succeeds. An aborted stream must never publish those bytes.
function saveHandle({ name = 'address-private-keys-ethereum-1-1000000.txt', failClose = false, failWrite = false, reportedSize } = {}) {
  const staged = [];
  const events = [];
  let published = new Uint8Array();
  let closed = false;
  let aborted = false;
  let writable;
  const handle = {
    name,
    events,
    get published() { return published; },
    get closed() { return closed; },
    get aborted() { return aborted; },
    async createWritable(options) {
      events.push(['createWritable', options]);
      writable = new WritableStream({
        write(chunk) {
          if (failWrite) {
            aborted = true;
            staged.length = 0;
            throw new Error('Disk write failed.');
          }
          if (closed || aborted) throw new Error('The save stream is already finished.');
          events.push('write');
          staged.push(new Uint8Array(chunk));
        },
        close() {
          events.push('close');
          if (failClose) {
            aborted = true;
            staged.length = 0;
            throw new Error('Could not finalize the TXT file.');
          }
          published = new Uint8Array(Buffer.concat(staged));
          closed = true;
        },
        abort() {
          events.push('abort');
          aborted = true;
          staged.length = 0;
        },
      });
      return writable;
    },
    async getFile() {
      events.push('getFile');
      return { name, size: reportedSize ?? published.byteLength };
    },
  };
  return handle;
}

function responseWithChunks(chunks, { headers = { 'content-type': 'text/plain; charset=utf-8' }, fail = false } = {}) {
  const encoder = new TextEncoder();
  const state = { cancelled: false, index: 0 };
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (state.index < chunks.length) controller.enqueue(encoder.encode(chunks[state.index++]));
      else if (fail) controller.error(new Error('Connection lost during download.'));
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers });
  return { response, state };
}

test('native scalar API requests keep the bearer token out of the URL', async () => {
  let captured;
  const result = await nativeScalarExportRequest('status', {
    id: 'job id/with reserved characters',
    accessToken: 'secret-token',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ job: { id: 'job' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.job.id, 'job');
  assert.equal(captured.url, '/api/native-scalar-export/status?id=job%20id%2Fwith%20reserved%20characters');
  assert.equal(captured.options.headers.authorization, 'Bearer secret-token');
  assert.equal(captured.url.includes('secret-token'), false);
});

test('native download writes, backpressures, explicitly closes and verifies the final TXT without a Blob', async () => {
  const handle = saveHandle();
  const progress = [];
  let pickerOptions;
  let captured;
  const expectedName = handle.name;
  const result = await streamNativeScalarExportDownload({
    jobId: 'job-123',
    accessToken: 'secret-token',
    suggestedName: expectedName,
    expectedBytes: '25',
    onProgress: (update) => progress.push({ ...update }),
    showSaveFilePicker: async (options) => {
      pickerOptions = options;
      handle.events.push('pick');
      return handle;
    },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      handle.events.push('fetch');
      return responseWithChunks(['first chunk\n', 'second chunk\n']).response;
    },
  });
  assert.equal(pickerOptions.suggestedName, expectedName);
  assert.deepEqual(pickerOptions.types, [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }]);
  assert.equal(captured.url, '/api/native-scalar-export/download?id=job-123');
  assert.equal(captured.options.headers.authorization, 'Bearer secret-token');
  assert.equal(captured.url.includes('secret-token'), false);
  assert.equal(Buffer.from(handle.published).toString(), 'first chunk\nsecond chunk\n');
  assert.equal(result.bytes, 25);
  assert.equal(result.fileName, expectedName);
  assert.equal(handle.closed, true);
  assert.equal(handle.aborted, false);
  assert.equal(handle.events[0], 'pick');
  assert.equal(handle.events[1][0], 'createWritable');
  assert.deepEqual(handle.events[1][1], { keepExistingData: false });
  assert.equal(handle.events[2], 'fetch');
  assert.ok(handle.events.indexOf('close') > handle.events.lastIndexOf('write'));
  assert.ok(handle.events.indexOf('getFile') > handle.events.indexOf('close'));
  assert.deepEqual(progress, [
    { phase: 'writing', completed: 12, total: 25 },
    { phase: 'writing', completed: 25, total: 25 },
    { phase: 'finalizing', completed: 25, total: 25 },
    { phase: 'verified', completed: 25, total: 25 },
  ]);
});

test('native download rejects an empty response instead of reporting a saved TXT', async () => {
  const handle = saveHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks([]).response,
  }), /empty/i);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
  assert.equal(handle.published.byteLength, 0);
});

test('a cleanly ended but truncated response never finalizes a partial TXT', async () => {
  const handle = saveHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['first chunk\n']).response,
  }), /incomplete.*12.*25/i);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
  assert.equal(handle.published.byteLength, 0);
});

test('an oversized response is rejected without publishing extra data', async () => {
  const handle = saveHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 5,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['too many bytes']).response,
  }), /larger than expected/i);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
});

test('a wrong content length is rejected before writing when the body is not compressed', async () => {
  const handle = saveHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['first chunk\n', 'second chunk\n'], {
      headers: { 'content-type': 'text/plain', 'content-length': '24' },
    }).response,
  }), /content-length/i);
  assert.equal(handle.events.includes('write'), false);
  assert.equal(handle.aborted, true);
});

test('a compressed response is checked against decompressed bytes, not its compressed content length', async () => {
  const handle = saveHandle();
  const result = await streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['first chunk\n', 'second chunk\n'], {
      headers: { 'content-type': 'text/plain', 'content-length': '18', 'content-encoding': 'gzip' },
    }).response,
  });
  assert.equal(result.bytes, 25);
  assert.equal(handle.closed, true);
});

test('an HTML or JSON error page cannot be saved as the requested TXT', async () => {
  for (const contentType of ['text/html', 'application/json']) {
    const handle = saveHandle();
    await assert.rejects(streamNativeScalarExportDownload({
      jobId: 'job-123', expectedBytes: 25,
      showSaveFilePicker: async () => handle,
      fetchImpl: async () => responseWithChunks(['not a TXT export'], { headers: { 'content-type': contentType } }).response,
    }), /text\/plain/i);
    assert.equal(handle.closed, false);
    assert.equal(handle.aborted, true);
  }
});

test('HTTP failures abort the save stream and preserve the server error', async () => {
  const handle = saveHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'The server copy expired.' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
  }), /server copy expired/i);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
});

test('network interruption cancels the source and aborts the staging file', async () => {
  const handle = saveHandle();
  const source = responseWithChunks(['first chunk\n'], { fail: true });
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => source.response,
  }), /Connection lost/);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
});

test('a disk write failure is surfaced and never followed by close', async () => {
  const handle = saveHandle({ failWrite: true });
  const source = responseWithChunks(['first chunk\n', 'second chunk\n']);
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => source.response,
  }), /Disk write failed/);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
  assert.equal(source.state.cancelled, true);
});

test('failure to finalize the TXT is not reported as download success', async () => {
  const handle = saveHandle({ failClose: true });
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['first chunk\n', 'second chunk\n']).response,
  }), /Could not finalize/);
  assert.equal(handle.closed, false);
  assert.equal(handle.aborted, true);
});

test('the final file must have the expected size even if closing reported success', async () => {
  const handle = saveHandle({ reportedSize: 0 });
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => handle,
    fetchImpl: async () => responseWithChunks(['first chunk\n', 'second chunk\n']).response,
  }), /saved file.*0.*25/i);
  assert.deepEqual(handle.events.slice(-2), ['close', 'getFile']);
});

test('invalid expected sizes fail before opening the picker', async () => {
  let picked = false;
  for (const expectedBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(streamNativeScalarExportDownload({
      jobId: 'job-123', expectedBytes,
      showSaveFilePicker: async () => { picked = true; },
    }), /expected.*size/i);
  }
  assert.equal(picked, false);
});

test('native download rejects browsers without streaming save support before fetching', async () => {
  let fetched = false;
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: undefined,
    fetchImpl: async () => { fetched = true; },
  }), /cannot stream an authenticated large download/);
  assert.equal(fetched, false);
});

test('cancelling the save picker does not fetch or create a file', async () => {
  let fetched = false;
  const cancelled = new Error('User cancelled the picker.');
  cancelled.name = 'AbortError';
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123', expectedBytes: 25,
    showSaveFilePicker: async () => { throw cancelled; },
    fetchImpl: async () => { fetched = true; },
  }), (error) => error === cancelled);
  assert.equal(fetched, false);
});

test('main passes the expected size, renders save progress and marks success only after verification', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const mode = networkId === 'ethereum' \? 'native' : 'browser'/);
  assert.match(source, /await runNativeBoundedWallet\(/);
  assert.match(source, /await streamNativeScalarExportDownload\(/);
  assert.match(source, /expectedBytes: result\.bytes/);
  assert.match(source, /onProgress: updateBoundedWalletDownloadProgress/);
  assert.match(source, /result\.downloaded = true/);
  assert.match(source, /Saved and verified/);
  assert.match(source, /#download-bounded-wallet'\)\?\.addEventListener\('click', downloadBoundedWallet\)/);
});

// --- Chosen download folder (showDirectoryPicker) path ---

function folderHandle({ name = 'SeedlabExports', existing = [], permission = 'granted', requestPermission = 'granted' } = {}) {
  const files = new Map(existing.map((fileName) => [fileName, new Uint8Array()]));
  const events = [];
  const handle = {
    name,
    events,
    files,
    async queryPermission(descriptor) {
      events.push(['queryPermission', descriptor]);
      return permission;
    },
    async requestPermission(descriptor) {
      events.push(['requestPermission', descriptor]);
      return requestPermission;
    },
    async getFileHandle(fileName, options = {}) {
      events.push(['getFileHandle', fileName, options]);
      if (files.has(fileName)) return fileFor(fileName);
      if (!options.create) {
        const error = new Error('File not found.');
        error.name = 'NotFoundError';
        throw error;
      }
      files.set(fileName, new Uint8Array());
      return fileFor(fileName);
    },
    async removeEntry(fileName) {
      events.push(['removeEntry', fileName]);
      files.delete(fileName);
    },
  };
  function fileFor(fileName) {
    const staged = [];
    return {
      name: fileName,
      async createWritable(options) {
        events.push(['createWritable', fileName, options]);
        return new WritableStream({
          write(chunk) {
            events.push(['write', fileName]);
            staged.push(new Uint8Array(chunk));
          },
          close() {
            events.push(['close', fileName]);
            files.set(fileName, new Uint8Array(Buffer.concat(staged)));
          },
          abort() {
            events.push(['abort', fileName]);
            staged.length = 0;
          },
        });
      },
      async getFile() {
        events.push(['getFile', fileName]);
        return { name: fileName, size: files.get(fileName).byteLength };
      },
    };
  }
  return handle;
}

test('a chosen folder bypasses the save picker and streams into a verified no-clobber TXT', async () => {
  const folder = folderHandle();
  let picked = false;
  const result = await streamNativeScalarExportDownload({
    jobId: 'job-123',
    accessToken: 'secret-token',
    suggestedName: 'keys.txt',
    expectedBytes: 25,
    directoryHandle: folder,
    showSaveFilePicker: async () => { picked = true; },
    fetchImpl: async () => {
      folder.events.push(['fetch']);
      return responseWithChunks(['first chunk\n', 'second chunk\n']).response;
    },
  });
  assert.equal(picked, false);
  assert.equal(result.bytes, 25);
  assert.equal(result.fileName, 'keys.txt');
  assert.equal(Buffer.from(folder.files.get('keys.txt')).toString(), 'first chunk\nsecond chunk\n');
  const order = folder.events.map(([event]) => event);
  // Permission is requested inside the click, before any network await; the
  // destination file is created only after the response headers validate.
  assert.ok(order.indexOf('queryPermission') < order.indexOf('fetch'));
  assert.ok(order.indexOf('getFileHandle') > order.indexOf('fetch'));
  assert.ok(order.indexOf('close') > order.lastIndexOf('write'));
  assert.ok(order.indexOf('getFile') > order.indexOf('close'));
});

test('a repeated folder export gets a unique name instead of overwriting', async () => {
  const folder = folderHandle({ existing: ['keys.txt'] });
  const result = await streamNativeScalarExportDownload({
    jobId: 'job-123',
    suggestedName: 'keys.txt',
    expectedBytes: 25,
    directoryHandle: folder,
    fetchImpl: async () => responseWithChunks(['first chunk\n', 'second chunk\n']).response,
  });
  assert.equal(result.fileName, 'keys-2.txt');
  assert.equal(folder.files.has('keys.txt'), true);
  assert.equal(folder.files.get('keys-2.txt').byteLength, 25);
});

test('folder permission denial rejects before any fetch or destination file', async () => {
  const folder = folderHandle({ permission: 'prompt', requestPermission: 'denied' });
  let fetched = false;
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123',
    suggestedName: 'keys.txt',
    expectedBytes: 25,
    directoryHandle: folder,
    fetchImpl: async () => { fetched = true; },
  }), /permission.*not granted/i);
  assert.equal(fetched, false);
  assert.equal(folder.files.size, 0);
});

test('an HTTP error with a chosen folder leaves no empty destination TXT', async () => {
  const folder = folderHandle();
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123',
    suggestedName: 'keys.txt',
    expectedBytes: 25,
    directoryHandle: folder,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'The server copy expired.' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
  }), /server copy expired/i);
  assert.equal(folder.files.size, 0);
});

test('a mid-stream failure with a chosen folder removes the incomplete destination', async () => {
  const folder = folderHandle();
  const source = responseWithChunks(['first chunk\n'], { fail: true });
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123',
    suggestedName: 'keys.txt',
    expectedBytes: 25,
    directoryHandle: folder,
    fetchImpl: async () => source.response,
  }), /Connection lost/);
  assert.equal(folder.files.has('keys.txt'), false);
  assert.equal(folder.events.some(([event]) => event === 'removeEntry'), true);
});

test('main passes the chosen directory handle to the native streaming helper', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const directoryHandle = downloadFolder\.handle/);
  assert.match(source, /directoryHandle,\n\s*showSaveFilePicker/);
});
