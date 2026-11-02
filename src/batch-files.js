export const MAX_BATCH_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ADDRESS_BATCH_TARGETS = 10_000;
export const MAX_RECOVERY_BATCH_ROWS = 1_000;

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ETH_TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
const HEADER = /^address(?:[\s,;\t]+(?:tx_?hash|transaction_?hash))?$/i;

function inputLines(contents) {
  if (typeof contents !== 'string') throw new Error('The batch input must be text.');
  return contents.split(/\r?\n/).map((line, index) => ({
    line: index + 1,
    text: line.trim().replace(/^\uFEFF/, ''),
  })).filter(({ text }) => text && !text.startsWith('#'));
}

function columns(text) {
  return text.split(/[\s,;\t]+/).map((value) => value.trim()).filter(Boolean);
}

function checkedAddress(value, line, validate) {
  const parsed = validate(value);
  if (!parsed?.valid) throw new Error(`Line ${line}: ${parsed?.reason ?? 'invalid address'}`);
  return parsed;
}

// Addresses may be one per line or separated by spaces, commas, semicolons or tabs.
// Ethereum additionally accepts address,transaction-hash rows for key extraction.
export function parseAddressBatch(contents, validate, { ethereumTransactions = false, maxTargets = MAX_ADDRESS_BATCH_TARGETS } = {}) {
  const tokens = [];
  const transactions = [];
  const transactionKeys = new Set();
  for (const { line, text } of inputLines(contents)) {
    if (HEADER.test(text)) continue;
    const values = columns(text);
    if (ethereumTransactions && values.length === 2 && ETH_ADDRESS.test(values[0]) && ETH_TRANSACTION.test(values[1])) {
      tokens.push({ value: values[0], line });
      const key = `${values[0].toLowerCase()}:${values[1].toLowerCase()}`;
      if (!transactionKeys.has(key)) {
        transactionKeys.add(key);
        transactions.push({ address: values[0], txHash: values[1] });
      }
      continue;
    }
    values.forEach((value) => tokens.push({ value, line }));
    if (tokens.length > maxTargets) throw new Error(`A batch can contain at most ${maxTargets.toLocaleString()} address entries.`);
  }
  if (!tokens.length) throw new Error('The text file contains no addresses.');
  if (tokens.length > maxTargets) throw new Error(`A batch can contain at most ${maxTargets.toLocaleString()} address entries.`);

  const unique = new Map();
  for (const { value, line } of tokens) {
    const parsed = checkedAddress(value, line, validate);
    // EVM and Bech32 parsers normalize to lowercase; Base58 remains case-sensitive.
    if (!unique.has(parsed.normalized)) unique.set(parsed.normalized, parsed.display);
  }
  return { addresses: [...unique.values()], transactions };
}

// Recovery batches preserve one provider request per row so failures and results
// can be reported independently. Ethereum: address,tx_hash. Bitcoin: address.
export function parseRecoveryBatch(contents, network, validate, { maxRows = MAX_RECOVERY_BATCH_ROWS } = {}) {
  if (network !== 'ethereum' && network !== 'bitcoin') throw new Error('Unsupported recovery batch network.');
  const entries = [];
  const unique = new Set();
  for (const { line, text } of inputLines(contents)) {
    if (HEADER.test(text)) continue;
    const values = columns(text);
    if (network === 'ethereum') {
      if (values.length !== 2 || !ETH_ADDRESS.test(values[0]) || !ETH_TRANSACTION.test(values[1])) {
        throw new Error(`Line ${line}: expected one Ethereum address and outgoing transaction hash, separated by a comma or tab.`);
      }
    } else if (values.length !== 1) {
      throw new Error(`Line ${line}: expected one Bitcoin address.`);
    }
    const parsed = checkedAddress(values[0], line, validate);
    const key = network === 'ethereum' ? `${parsed.normalized}:${values[1].toLowerCase()}` : parsed.normalized;
    if (unique.has(key)) continue;
    unique.add(key);
    entries.push({ address: parsed.display, txHash: network === 'ethereum' ? values[1] : '' });
    if (entries.length > maxRows) throw new Error(`A recovery batch can contain at most ${maxRows.toLocaleString()} rows.`);
  }
  if (!entries.length) throw new Error('The text file contains no recovery rows.');
  return entries;
}

function cell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function publicKeyResultsTsv(results, { successfulOnly = false } = {}) {
  const rows = successfulOnly ? results.filter((row) => row.status === 'ok' && row.publicKey) : results;
  if (successfulOnly && !rows.length) throw new Error('No successfully recovered public keys are available to load.');
  return [
    'address\ttransaction_hash\tpublic_key_uncompressed\tstatus',
    ...rows.map((row) => [row.address, row.txHash, row.publicKey, row.status].map(cell).join('\t')),
  ].join('\n') + '\n';
}
