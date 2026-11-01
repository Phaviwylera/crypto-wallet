// Parse an uploaded wallet file into a list of raw input lines.
// Supported formats:
//   - .txt / .csv : one secret per line (csv uses the first column), blank lines and '#' comments ignored
//   - .json       : a JSON array of strings, or an array of { secret } / { mnemonic } / { privateKey } objects
export function parseWalletFile(filename, content) {
  const name = String(filename || '').toLowerCase();
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');

  if (name.endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Uploaded .json file is not valid JSON.');
    }
    if (!Array.isArray(data)) throw new Error('Uploaded .json must be an array of secrets.');
    return data.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        return entry.secret ?? entry.mnemonic ?? entry.privateKey ?? entry.private_key ?? entry.key ?? '';
      }
      return String(entry);
    });
  }

  if (name.endsWith('.csv')) {
    return text
      .split(/\r?\n/)
      .map((line) => line.split(/[,;\t]/)[0]?.trim() ?? '')
      .filter((line) => line && !line.startsWith('#'));
  }

  // Default: plain text, one per line
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}
