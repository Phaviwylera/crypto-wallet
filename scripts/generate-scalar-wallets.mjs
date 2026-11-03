#!/usr/bin/env node
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { calculateAddressData, NETWORK_IDS } from '../server/lib/networks.mjs';
import { parseSearchRange } from '../src/search-range.js';
import { scalarBatchRow } from '../src/scalar-wallet.js';

const DEFAULT_CHUNK_SIZE = 500;

export function deriveScalarWallet(scalar, network = 'ethereum') {
  if (!NETWORK_IDS.includes(network)) throw new Error(`Unknown network: ${network}`);
  const privateBytes = Uint8Array.from(Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex'));
  try {
    const privateKey = `0x${Buffer.from(privateBytes).toString('hex')}`;
    const derived = calculateAddressData(privateBytes, network);
    return { address: derived.address, privateKey };
  } finally {
    privateBytes.fill(0);
  }
}

function cancellationError() {
  const error = new Error('Export cancelled; the .partial file is incomplete.');
  error.name = 'AbortError';
  return error;
}

export async function streamScalarWalletExport({
  lower,
  upper,
  network = 'ethereum',
  write,
  derive = (scalar) => deriveScalarWallet(scalar, network),
  shouldCancel = () => false,
  onProgress = () => {},
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  const range = parseSearchRange(lower, upper);
  if (!NETWORK_IDS.includes(network)) throw new Error(`Unknown network: ${network}`);
  if (typeof write !== 'function') throw new Error('A streaming write function is required.');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10000) throw new Error('Chunk size must be an integer from 1 through 10,000.');

  let rows = [];
  let completed = 0n;
  const flush = async () => {
    if (!rows.length) return;
    const size = rows.length;
    const text = rows.join('');
    rows = [];
    await write(text);
    completed += BigInt(size);
    onProgress(completed, range.count);
  };

  for (let scalar = range.start; scalar <= range.end; scalar += 1n) {
    if (shouldCancel()) throw cancellationError();
    const derived = derive(scalar);
    rows.push(scalarBatchRow(derived.address, derived.privateKey));
    if (rows.length >= chunkSize) await flush();
  }
  if (shouldCancel()) throw cancellationError();
  await flush();
  return { count: completed, range };
}

export async function exportScalarWalletFile({
  output,
  lower,
  upper,
  network = 'ethereum',
  onProgress = () => {},
  shouldCancel = () => false,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  if (!output) throw new Error('An output TXT path is required.');
  // Validate before creating a partial file.
  parseSearchRange(lower, upper);
  if (!NETWORK_IDS.includes(network)) throw new Error(`Unknown network: ${network}`);
  const outputPath = path.resolve(output);
  const partialPath = `${outputPath}.partial`;
  if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  if (existsSync(partialPath)) throw new Error(`Incomplete partial file already exists: ${partialPath}; move or delete it before restarting.`);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const stream = createWriteStream(partialPath, { flags: 'wx', mode: 0o600 });
  try {
    await once(stream, 'open');
    const result = await streamScalarWalletExport({
      lower, upper, network, onProgress, shouldCancel, chunkSize,
      write: async (text) => {
        if (!stream.write(text)) await once(stream, 'drain');
      },
    });
    stream.end();
    await once(stream, 'finish');
    await rename(partialPath, outputPath);
    return { ...result, outputPath, bytes: statSync(outputPath).size };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function usage() {
  return `Stream inclusive scalar address/private-key rows directly to a local TXT.

Usage:
  npm run export:scalars -- --start 1 --end 10000000 --network ethereum --output exports/ethereum-1-10000000.txt

Options:
  --start       Inclusive decimal lower scalar (required)
  --end         Inclusive decimal upper scalar (required)
  --network     ${NETWORK_IDS.join(', ')} (default: ethereum)
  --output      New local TXT path (required; never overwritten)
  --chunk-size  Rows per streaming write, 1–10000 (default: ${DEFAULT_CHUNK_SIZE})
  --help        Show this help

The file has no header: address<TAB>0x-prefixed 32-byte private key per line.
A .partial file is incomplete. Only a successful run renames it to the requested TXT.
Existing output and partial paths are never overwritten. Keep the TXT secret.`;
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      start: { type: 'string' },
      end: { type: 'string' },
      network: { type: 'string', default: 'ethereum' },
      output: { type: 'string' },
      'chunk-size': { type: 'string', default: String(DEFAULT_CHUNK_SIZE) },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.start || !values.end || !values.output) throw new Error(`--start, --end and --output are required.\n\n${usage()}`);

  const startedAt = Date.now();
  let lastProgress = 0;
  const onProgress = (completed, total) => {
    const now = Date.now();
    if (completed !== total && now - lastProgress < 5000) return;
    lastProgress = now;
    const percent = Number((completed * 10000n) / total) / 100;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    const rate = Math.round(Number(completed) / elapsedSeconds).toLocaleString('en-US');
    process.stderr.write(`Generated ${completed.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} rows (${percent.toFixed(2)}%) · ${rate} rows/s\n`);
  };
  const result = await exportScalarWalletFile({
    lower: values.start,
    upper: values.end,
    network: values.network,
    output: values.output,
    chunkSize: Number(values['chunk-size']),
    onProgress,
  });
  console.log(`Complete: ${result.count.toLocaleString('en-US')} rows, ${result.bytes.toLocaleString('en-US')} bytes`);
  console.log(`Saved locally: ${result.outputPath}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli().catch((error) => {
    console.error(`Export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
