export const SCALAR_EXPORT_FORMATS = Object.freeze({
  txt: Object.freeze({ extension: 'txt', mimeType: 'text/plain', label: 'TXT', description: 'Text file' }),
  csv: Object.freeze({ extension: 'csv', mimeType: 'text/csv', label: 'CSV', description: 'CSV spreadsheet' }),
});

export const SCALAR_CSV_HEADER = 'address,private_key\r\n';
export const SCALAR_CSV_HEADER_BYTES = 21;
export const NATIVE_TSV_ROW_BYTES = 110n;
export const NATIVE_CSV_ROW_BYTES = 111n;

export function normalizeScalarExportFormat(value = 'txt') {
  const format = String(value ?? 'txt').trim().toLowerCase();
  if (!Object.hasOwn(SCALAR_EXPORT_FORMATS, format)) {
    throw new Error('Export format must be TXT or CSV.');
  }
  return format;
}

export function scalarExportFileTypes(value = 'txt') {
  const format = normalizeScalarExportFormat(value);
  const { description, mimeType, extension } = SCALAR_EXPORT_FORMATS[format];
  return [{ description, accept: { [mimeType]: [`.${extension}`] } }];
}

export function scalarExportFileName(fileName, value = 'txt') {
  const { extension } = SCALAR_EXPORT_FORMATS[normalizeScalarExportFormat(value)];
  if (typeof fileName !== 'string' || !/\.(txt|csv)$/i.test(fileName)) {
    throw new Error('The export file name must end in .txt or .csv.');
  }
  return fileName.replace(/\.(txt|csv)$/i, `.${extension}`);
}

export function nativeScalarExportByteCount(count, value = 'txt') {
  const format = normalizeScalarExportFormat(value);
  const rows = BigInt(count);
  if (rows < 0n) throw new Error('Export row count cannot be negative.');
  return format === 'csv'
    ? BigInt(SCALAR_CSV_HEADER_BYTES) + rows * NATIVE_CSV_ROW_BYTES
    : rows * NATIVE_TSV_ROW_BYTES;
}

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function scalarCsvRow(address, privateKey) {
  if (typeof address !== 'string' || !address || typeof privateKey !== 'string' || !privateKey) {
    throw new Error('The export contains an invalid address/private-key row; no CSV was created.');
  }
  return `${csvField(address)},${csvField(privateKey)}\r\n`;
}

// The generators keep a canonical headerless TSV in memory/server storage.
// CSV is a download-time view: one header row, comma separators and CRLF.
export function scalarTsvToCsv(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('The export is empty; no CSV was created.');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows = [SCALAR_CSV_HEADER];
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 2) {
      throw new Error('The export contains an invalid address/private-key row; no CSV was created.');
    }
    rows.push(scalarCsvRow(fields[0], fields[1]));
  }
  return rows.join('');
}
