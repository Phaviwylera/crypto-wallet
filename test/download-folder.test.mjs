import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExportFileHandle,
  ensureExportFolderPermission,
  saveTextToExportFolder,
  utf8ByteLength,
  validateExportFileName,
} from '../src/download-folder.js';

function notFound() {
  const error = new Error('File not found.');
  error.name = 'NotFoundError';
  return error;
}

// Model a File System Access directory: writes stay staged until close(), and
// removeEntry() is the cleanup path for a failed no-clobber destination.
function directoryHandle({
  name = 'SeedlabExports',
  existing = [],
  permission = 'granted',
  requestPermission = 'granted',
  failWrite = false,
  failClose = false,
  reportedSize,
} = {}) {
  const files = new Map(existing.map((fileName) => [fileName, { bytes: new Uint8Array(), closed: true, aborted: false }]));
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
      if (files.has(fileName)) return fileHandle(fileName);
      if (!options.create) throw notFound();
      files.set(fileName, { bytes: new Uint8Array(), closed: false, aborted: false });
      return fileHandle(fileName);
    },
    async removeEntry(fileName) {
      events.push(['removeEntry', fileName]);
      files.delete(fileName);
    },
  };

  function fileHandle(fileName) {
    const staged = [];
    return {
      name: fileName,
      async createWritable(options) {
        events.push(['createWritable', fileName, options]);
        return new WritableStream({
          write(chunk) {
            const state = files.get(fileName);
            if (failWrite) {
              state.aborted = true;
              staged.length = 0;
              throw new Error('Disk write failed.');
            }
            if (state.closed || state.aborted) throw new Error('The save stream is already finished.');
            events.push(['write', fileName]);
            staged.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
          },
          close() {
            events.push(['close', fileName]);
            const state = files.get(fileName);
            if (failClose) {
              state.aborted = true;
              staged.length = 0;
              throw new Error('Could not finalize the TXT file.');
            }
            state.bytes = new Uint8Array(Buffer.concat(staged));
            state.closed = true;
          },
          abort() {
            events.push(['abort', fileName]);
            const state = files.get(fileName);
            state.aborted = true;
            staged.length = 0;
          },
        });
      },
      async getFile() {
        events.push(['getFile', fileName]);
        const state = files.get(fileName);
        return { name: fileName, size: reportedSize ?? state.bytes.byteLength };
      },
    };
  }

  return handle;
}

test('utf8ByteLength counts UTF-8 bytes, including surrogate pairs', () => {
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength('abc\t0x123\n'), 10);
  assert.equal(utf8ByteLength('é'), 2);
  assert.equal(utf8ByteLength('₹'), 3);
  assert.equal(utf8ByteLength('😀'), 4);
  assert.equal(utf8ByteLength('a😀é'), 7);
});

test('export file names are safe .txt or .csv basenames, not paths', () => {
  assert.equal(validateExportFileName('address-private-keys-ethereum-1-1000.txt'), 'address-private-keys-ethereum-1-1000.txt');
  assert.equal(validateExportFileName('address-private-keys-ethereum-1-1000.csv'), 'address-private-keys-ethereum-1-1000.csv');
  for (const name of [
    '', '.txt', '.csv', 'keys.tsv', '../keys.txt', 'D:\\keys.csv', 'folder/keys.txt', 'keys.txt\n',
    'keys.txt ', ' keys.csv', 'keys..txt', 'keys .csv', 'con.txt', 'LPT1.csv', 'a'.repeat(252) + '.txt',
  ]) {
    assert.throws(() => validateExportFileName(name), /safe \.txt or \.csv file name/);
  }
});

test('folder permission is queried, then requested only when needed', async () => {
  const granted = directoryHandle();
  await ensureExportFolderPermission(granted);
  assert.deepEqual(granted.events, [['queryPermission', { mode: 'readwrite' }]]);

  const prompt = directoryHandle({ permission: 'prompt' });
  await ensureExportFolderPermission(prompt);
  assert.deepEqual(prompt.events, [
    ['queryPermission', { mode: 'readwrite' }],
    ['requestPermission', { mode: 'readwrite' }],
  ]);

  const denied = directoryHandle({ permission: 'prompt', requestPermission: 'denied' });
  await assert.rejects(ensureExportFolderPermission(denied), /permission.*not granted/i);
  await assert.rejects(ensureExportFolderPermission(null), /Choose a download folder first/);

  const opfsLike = { name: 'opfs', async getFileHandle() { throw notFound(); } };
  await ensureExportFolderPermission(opfsLike);
});

test('a repeated export never silently overwrites an earlier private-key file', async () => {
  const folder = directoryHandle({ existing: ['keys.txt', 'keys-2.txt'] });
  const handle = await createExportFileHandle(folder, 'keys.txt');
  assert.equal(handle.name, 'keys-3.txt');
  assert.equal(folder.files.has('keys.txt'), true);
  assert.equal(folder.files.has('keys-2.txt'), true);
  assert.equal(folder.files.has('keys-3.txt'), true);

  const fresh = directoryHandle();
  assert.equal((await createExportFileHandle(fresh, 'keys.txt')).name, 'keys.txt');

  const csvFolder = directoryHandle({ existing: ['keys.csv', 'keys-2.csv'] });
  assert.equal((await createExportFileHandle(csvFolder, 'keys.csv')).name, 'keys-3.csv');
  assert.equal(csvFolder.files.has('keys.csv'), true);
  assert.equal(csvFolder.files.has('keys-2.csv'), true);
});

test('createExportFileHandle can skip a redundant permission prompt but still requires a folder', async () => {
  const folder = directoryHandle({ permission: 'prompt', requestPermission: 'denied' });
  const handle = await createExportFileHandle(folder, 'keys.txt', { ensurePermission: false });
  assert.equal(handle.name, 'keys.txt');
  assert.equal(folder.events.some(([event]) => event === 'queryPermission'), false);
  await assert.rejects(createExportFileHandle(null, 'keys.txt', { ensurePermission: false }), /Choose a download folder first/);
});

test('saving browser-generated text closes, verifies and reports the selected folder', async () => {
  const folder = directoryHandle();
  const progress = [];
  const result = await saveTextToExportFolder({
    directoryHandle: folder,
    suggestedName: 'keys.txt',
    contents: 'address\t0xkey\n',
    onProgress: (update) => progress.push({ ...update }),
  });
  const expectedBytes = utf8ByteLength('address\t0xkey\n');
  assert.deepEqual(result, { bytes: expectedBytes, fileName: 'keys.txt', folderName: 'SeedlabExports' });
  assert.equal(Buffer.from(folder.files.get('keys.txt').bytes).toString(), 'address\t0xkey\n');
  assert.equal(folder.files.get('keys.txt').closed, true);
  assert.deepEqual(progress, [
    { phase: 'writing', completed: expectedBytes, total: expectedBytes },
    { phase: 'finalizing', completed: expectedBytes, total: expectedBytes },
    { phase: 'verified', completed: expectedBytes, total: expectedBytes },
  ]);
  const order = folder.events.map(([event]) => event);
  assert.ok(order.indexOf('close') > order.lastIndexOf('write'));
  assert.ok(order.indexOf('getFile') > order.indexOf('close'));
});

test('saving multibyte text verifies the UTF-8 byte count, not the string length', async () => {
  const folder = directoryHandle();
  const contents = 'addréss😀\t0xkey\n';
  const result = await saveTextToExportFolder({ directoryHandle: folder, suggestedName: 'keys.txt', contents });
  assert.equal(result.bytes, utf8ByteLength(contents));
  assert.ok(result.bytes > contents.length);
});

test('saving browser-generated CSV writes the exact comma-separated bytes and verifies size', async () => {
  const folder = directoryHandle();
  const contents = 'address,private_key\r\n0xabc,0x123\r\n';
  const result = await saveTextToExportFolder({ directoryHandle: folder, suggestedName: 'keys.csv', contents });
  assert.equal(result.fileName, 'keys.csv');
  assert.equal(result.bytes, utf8ByteLength(contents));
  assert.equal(Buffer.from(folder.files.get('keys.csv').bytes).toString(), contents);
  assert.equal(folder.files.get('keys.csv').closed, true);
});

test('empty browser text is rejected before a destination file is created', async () => {
  const folder = directoryHandle();
  await assert.rejects(saveTextToExportFolder({
    directoryHandle: folder, suggestedName: 'keys.txt', contents: '',
  }), /empty/i);
  assert.equal(folder.files.size, 0);
  assert.equal(folder.events.length, 0);
});

test('write, close and size failures abort staging and remove the incomplete destination', async () => {
  for (const options of [{ failWrite: true }, { failClose: true }, { reportedSize: 0 }]) {
    const folder = directoryHandle(options);
    await assert.rejects(saveTextToExportFolder({
      directoryHandle: folder, suggestedName: 'keys.txt', contents: 'address\t0xkey\n',
    }));
    assert.equal(folder.files.has('keys.txt'), false);
    assert.equal(folder.events.some(([event]) => event === 'removeEntry'), true);
  }
});

test('permission denial happens before any destination file is created', async () => {
  const folder = directoryHandle({ permission: 'prompt', requestPermission: 'denied' });
  await assert.rejects(saveTextToExportFolder({
    directoryHandle: folder, suggestedName: 'keys.txt', contents: 'address\t0xkey\n',
  }), /permission.*not granted/i);
  assert.equal(folder.files.size, 0);
  assert.equal(folder.events.some(([event]) => event === 'getFileHandle'), false);
});

test('main wires the folder picker into the bounded-wallet download flow', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /showDirectoryPicker\(\{/);
  assert.match(source, /mode: 'readwrite'/);
  assert.match(source, /#choose-download-folder'\)\?\.addEventListener\('click', chooseDownloadFolder\)/);
  assert.match(source, /#clear-download-folder'\)\?\.addEventListener\('click', clearDownloadFolder\)/);
  assert.match(source, /await saveTextToExportFolder\(/);
  assert.match(source, /directoryHandle,/);
  assert.match(source, /savedFolderName/);
});
