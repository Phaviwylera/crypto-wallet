import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_CSV_ROW_BYTES,
  NATIVE_TSV_ROW_BYTES,
  SCALAR_CSV_HEADER,
  SCALAR_CSV_HEADER_BYTES,
  SCALAR_EXPORT_FORMATS,
  nativeScalarExportByteCount,
  normalizeScalarExportFormat,
  scalarCsvRow,
  scalarExportFileName,
  scalarExportFileTypes,
  scalarTsvToCsv,
} from '../src/scalar-export-format.js';

test('export formats normalize to txt/csv and reject anything else', () => {
  assert.equal(normalizeScalarExportFormat(), 'txt');
  assert.equal(normalizeScalarExportFormat('TXT'), 'txt');
  assert.equal(normalizeScalarExportFormat(' csv '), 'csv');
  assert.equal(normalizeScalarExportFormat(null), 'txt');
  for (const value of ['tsv', 'xlsx', '', 1]) {
    assert.throws(() => normalizeScalarExportFormat(value), /TXT or CSV/);
  }
  assert.deepEqual(Object.keys(SCALAR_EXPORT_FORMATS), ['txt', 'csv']);
});

test('picker types and file names follow the selected extension', () => {
  assert.deepEqual(scalarExportFileTypes('txt'), [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }]);
  assert.deepEqual(scalarExportFileTypes('csv'), [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }]);
  assert.equal(scalarExportFileName('keys.txt', 'csv'), 'keys.csv');
  assert.equal(scalarExportFileName('keys.csv', 'txt'), 'keys.txt');
  assert.equal(scalarExportFileName('KEYS.CSV', 'csv'), 'KEYS.csv');
  assert.throws(() => scalarExportFileName('keys.tsv', 'csv'), /must end in \.txt or \.csv/);
});

test('native byte counts match the fixed-width TSV and CSV layouts', () => {
  assert.equal(SCALAR_CSV_HEADER, 'address,private_key\r\n');
  assert.equal(Buffer.byteLength(SCALAR_CSV_HEADER), SCALAR_CSV_HEADER_BYTES);
  assert.equal(NATIVE_TSV_ROW_BYTES, 110n);
  assert.equal(NATIVE_CSV_ROW_BYTES, 111n);
  assert.equal(nativeScalarExportByteCount(0, 'txt'), 0n);
  assert.equal(nativeScalarExportByteCount(0, 'csv'), 21n);
  assert.equal(nativeScalarExportByteCount(100, 'txt'), 11000n);
  assert.equal(nativeScalarExportByteCount(100, 'csv'), 11121n);
  assert.equal(nativeScalarExportByteCount(256, 'csv'), 28437n);
  assert.throws(() => nativeScalarExportByteCount(-1, 'csv'), /negative/);
});

test('CSV rows use comma separators, CRLF and defensive RFC-4180 quoting', () => {
  assert.equal(scalarCsvRow('0xabc', '0x123'), '0xabc,0x123\r\n');
  assert.equal(scalarCsvRow('a,b', '0x123'), '"a,b",0x123\r\n');
  assert.equal(scalarCsvRow('a"b', '0x123'), '"a""b",0x123\r\n');
  assert.equal(scalarCsvRow('a\nb', '0x123'), '"a\nb",0x123\r\n');
  assert.throws(() => scalarCsvRow('', '0x123'), /invalid address\/private-key row/);
  assert.throws(() => scalarCsvRow('0xabc', ''), /invalid address\/private-key row/);
});

test('scalarTsvToCsv converts canonical headerless TSV at download time', () => {
  const tsv = '0xabc\t0x123\n0xdef\t0x456\n';
  assert.equal(scalarTsvToCsv(tsv), 'address,private_key\r\n0xabc,0x123\r\n0xdef,0x456\r\n');
  assert.equal(scalarTsvToCsv('0xabc\t0x123'), 'address,private_key\r\n0xabc,0x123\r\n');
  assert.throws(() => scalarTsvToCsv(''), /empty/);
  assert.throws(() => scalarTsvToCsv('0xabc\n'), /invalid address\/private-key row/);
  assert.throws(() => scalarTsvToCsv('0xabc\t0x123\textra\n'), /invalid address\/private-key row/);
});
