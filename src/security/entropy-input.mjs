import { MAX_ENTROPY_BYTES, MIN_ENTROPY_BYTES } from './entropy-core.mjs';

export const ENTROPY_INPUT_FORMATS = ['binary', 'hex', 'base64', 'json-bytes'];

function cleanHex(text) {
  const value = text.replace(/^\uFEFF/, '').trim().replace(/^0x/i, '').replace(/[\s,:;_-]+/g, '');
  if (!value.length || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) throw new Error('Hex input must contain complete byte pairs (0–9, a–f), with optional whitespace or separators.');
  return value;
}

export function decodeEntropyText(text, format) {
  if (typeof text !== 'string') throw new TypeError('Expected text input.');
  if (text.length > MAX_ENTROPY_BYTES * 4 + 1024) throw new Error('Input is too large. The raw-byte limit is 8 MiB.');
  let bytes;
  if (format === 'hex') {
    const value = cleanHex(text);
    bytes = Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
  } else if (format === 'base64') {
    const value = text.replace(/\s+/g, '');
    if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Invalid base64 input.');
    try { bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); } catch { throw new Error('Invalid base64 input.'); }
  } else if (format === 'json-bytes') {
    let values;
    try { values = JSON.parse(text); } catch { throw new Error('Invalid JSON byte array.'); }
    if (!Array.isArray(values) || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('JSON input must be an array of integers from 0 to 255.');
    bytes = Uint8Array.from(values);
  } else {
    throw new Error('Choose hex, base64, or JSON bytes for pasted text. Binary files are supported through file upload.');
  }
  validateEntropyLength(bytes.length);
  return bytes;
}

export function validateEntropyLength(length) {
  if (length < MIN_ENTROPY_BYTES) throw new Error(`At least ${MIN_ENTROPY_BYTES} raw bytes are required. Do not paste a private key or recovery phrase; collect fresh generator output instead.`);
  if (length > MAX_ENTROPY_BYTES) throw new Error('The raw-byte limit is 8 MiB.');
}

export async function readEntropyFile(file, format = 'binary') {
  if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('Choose a sample file.');
  if (file.size > MAX_ENTROPY_BYTES * 4 + 1024) throw new Error('Sample file is too large.');
  if (format === 'binary') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateEntropyLength(bytes.length);
    return bytes;
  }
  return decodeEntropyText(await file.text(), format);
}
