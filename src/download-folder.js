import { scalarExportFileTypes } from './scalar-export-format.js';

export const TEXT_FILE_TYPES = scalarExportFileTypes('txt');

export function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) { bytes += 4; index += 1; }
    else if (code > 0x7ff) bytes += 3;
    else if (code > 0x7f) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

export function validateExportFileName(name) {
  if (typeof name !== 'string' || !/\.(txt|csv)$/i.test(name) || name.length > 255 ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /^\.(txt|csv)$/i.test(name) ||
      name.endsWith('.') || name.endsWith(' ') || name.startsWith(' ') ||
      name.slice(0, -4).endsWith('.') || name.slice(0, -4).endsWith(' ') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.(txt|csv)$/i.test(name)) {
    throw new Error('The export file name must be a safe .txt or .csv file name, not a path.');
  }
  return name;
}

export async function ensureExportFolderPermission(directoryHandle) {
  if (!directoryHandle || typeof directoryHandle.getFileHandle !== 'function') {
    throw new Error('Choose a download folder first.');
  }
  const descriptor = { mode: 'readwrite' };
  const canQuery = typeof directoryHandle.queryPermission === 'function';
  const canRequest = typeof directoryHandle.requestPermission === 'function';
  if (canQuery) {
    const state = await directoryHandle.queryPermission(descriptor);
    if (state === 'granted') return;
  }
  if (canRequest) {
    const state = await directoryHandle.requestPermission(descriptor);
    if (state === 'granted') return;
  }
  // Some handle implementations (for example OPFS used by automated checks)
  // expose no permission prompt. Let the actual write surface any real denial.
  if (!canQuery && !canRequest) return;
  throw new Error('Write permission for the download folder was not granted. Choose the folder again and allow access.');
}

// The File System Access API has no portable exclusive-create flag. Probe first
// so a repeated export never silently replaces an earlier private-key export.
export async function createExportFileHandle(directoryHandle, suggestedName, { ensurePermission = true } = {}) {
  validateExportFileName(suggestedName);
  if (ensurePermission) {
    await ensureExportFolderPermission(directoryHandle);
  } else if (!directoryHandle || typeof directoryHandle.getFileHandle !== 'function') {
    throw new Error('Choose a download folder first.');
  }
  const extension = suggestedName.slice(-4);
  const base = suggestedName.slice(0, -4);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = attempt === 0 ? suggestedName : `${base}-${attempt + 1}${extension}`;
    try {
      await directoryHandle.getFileHandle(name, { create: false });
      continue;
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
    return directoryHandle.getFileHandle(name, { create: true });
  }
  throw new Error('Too many files with this export name already exist in the selected folder. Choose another folder or move older exports.');
}

export async function saveTextToExportFolder({
  directoryHandle,
  suggestedName,
  contents,
  onProgress = () => {},
}) {
  if (typeof contents !== 'string' || contents.length === 0) {
    throw new Error('The browser-generated export is empty; no file was saved.');
  }
  const total = utf8ByteLength(contents);
  const handle = await createExportFileHandle(directoryHandle, suggestedName);
  let writer;
  let closed = false;
  let verified = false;
  try {
    const writable = await handle.createWritable({ keepExistingData: false });
    writer = writable.getWriter();
    // This path is only for the existing in-memory browser generator. Writing
    // the string directly avoids creating a second whole-file byte array/Blob.
    await writer.write(contents);
    onProgress({ phase: 'writing', completed: total, total });
    onProgress({ phase: 'finalizing', completed: total, total });
    await writer.close();
    closed = true;
    const savedFile = await handle.getFile();
    if (savedFile.size !== total) {
      throw new Error(`The saved file has ${savedFile.size} bytes; expected ${total}. Do not use this incomplete export; retry the download.`);
    }
    verified = true;
    onProgress({ phase: 'verified', completed: total, total });
    return { bytes: savedFile.size, fileName: handle.name, folderName: directoryHandle.name || '' };
  } catch (error) {
    if (writer && !closed) {
      try { await writer.abort(error); } catch { /* Preserve the original error. */ }
    }
    if (!verified) {
      // This path created a fresh no-clobber file name. Do not leave an empty
      // or incomplete private-key export that could be mistaken for a good file.
      try { await directoryHandle.removeEntry(handle.name); } catch { /* Best effort. */ }
    }
    throw error;
  } finally {
    try { writer?.releaseLock(); } catch { /* Closing releases the writer. */ }
  }
}
