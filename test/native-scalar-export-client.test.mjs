import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeScalarExportRequest, streamNativeScalarExportDownload } from '../src/native-scalar-export.js';

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

test('native download pipes response chunks to a save-file stream without a Blob', async () => {
  const chunks = [];
  let pickerOptions;
  let captured;
  const expectedName = 'address-private-keys-ethereum-1-1000000.txt';
  await streamNativeScalarExportDownload({
    jobId: 'job-123',
    accessToken: 'secret-token',
    suggestedName: expectedName,
    showSaveFilePicker: async (options) => {
      pickerOptions = options;
      return {
        createWritable: async () => new WritableStream({
          write(chunk) { chunks.push(Array.from(chunk)); },
        }),
      };
    },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('first chunk\n'));
          controller.enqueue(encoder.encode('second chunk\n'));
          controller.close();
        },
      }), { status: 200 });
    },
  });
  assert.equal(pickerOptions.suggestedName, expectedName);
  assert.equal(captured.url, '/api/native-scalar-export/download?id=job-123');
  assert.equal(captured.options.headers.authorization, 'Bearer secret-token');
  assert.equal(captured.url.includes('secret-token'), false);
  assert.deepEqual(chunks.flat(), Array.from(new TextEncoder().encode('first chunk\nsecond chunk\n')));
});

test('native download rejects browsers without streaming save support before fetching', async () => {
  let fetched = false;
  await assert.rejects(streamNativeScalarExportDownload({
    jobId: 'job-123',
    showSaveFilePicker: undefined,
    fetchImpl: async () => { fetched = true; },
  }), /cannot stream an authenticated large download/);
  assert.equal(fetched, false);
});

test('main bounded generator routes Ethereum to native mode and native downloads to the stream helper', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const mode = networkId === 'ethereum' \? 'native' : 'browser'/);
  assert.match(source, /await runNativeBoundedWallet\(/);
  assert.match(source, /await streamNativeScalarExportDownload\(/);
  assert.match(source, /#download-bounded-wallet'\)\?\.addEventListener\('click', downloadBoundedWallet\)/);
});
