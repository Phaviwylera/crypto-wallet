#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSearchRange } from '../src/search-range.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function nativeScalarExporterPath() {
  return process.env.SEEDLAB_ETH_EXPORT_BIN || path.join(ROOT, '.runtime', 'bin', 'seedlab-eth-export');
}

export async function runNativeScalarWalletExport({
  lower,
  upper,
  output,
  network = 'ethereum',
  threads = 2,
  chunkSize = 4096,
  binary = nativeScalarExporterPath(),
}) {
  // Validate the mathematical bounds before creating a partial file. The C
  // binary validates them again at the process boundary.
  const range = parseSearchRange(lower, upper);
  if (network !== 'ethereum') throw new Error('The native scalar exporter currently supports Ethereum only.');
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw new Error('Threads must be an integer from 1 through 32.');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 65536) throw new Error('Chunk size must be an integer from 1 through 65,536.');
  if (!output) throw new Error('An output TXT path is required.');
  const outputPath = path.resolve(output);
  const partialPath = `${outputPath}.partial`;
  if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  if (existsSync(partialPath)) throw new Error(`Incomplete partial file already exists: ${partialPath}; move or delete it before restarting.`);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '--start', range.start.toString(), '--end', range.end.toString(),
    '--output', outputPath, '--threads', String(threads), '--chunk-size', String(chunkSize),
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit' });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if (error) reject(error); else resolve();
    };
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(new Error(`Native exporter not found at ${binary}. Run npm run export:scalars:native:setup first.`));
      } else finish(error);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Native exporter ${signal ? `received ${signal}` : `exited with code ${code}`}; only a .partial file may remain.`));
    });
  });
  return { outputPath };
}

function usage() {
  return `Generate every Ethereum address/private-key pair with the parallel native exporter.

Setup:
  npm run export:scalars:native:setup

Usage:
  npm run export:scalars:native -- --start 1 --end 1000000 --output exports/ethereum-1-1000000.txt

Options:
  --start       Inclusive decimal lower scalar (required)
  --end         Inclusive decimal upper scalar (required)
  --network     ethereum (default; no other network is supported natively)
  --output      New local TXT path (required; never overwritten)
  --threads     Parallel workers, 1–32 (default: 2)
  --chunk-size  Rows per batch, 1–65536 (default: 4096)
  --help        Show this help

Ethereum only. Each row is exactly 110 bytes: EIP-55 address<TAB>0x-private-key<LF>.
There is no header or artificial row cap. Output is streamed at ordered file offsets,
not accumulated in memory. A .partial file is incomplete. Keep the final TXT secret.
Throughput is hardware/filesystem dependent; the CLI reports its measured rate.`;
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      start: { type: 'string' },
      end: { type: 'string' },
      network: { type: 'string', default: 'ethereum' },
      output: { type: 'string' },
      threads: { type: 'string', default: '2' },
      'chunk-size': { type: 'string', default: '4096' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.start || !values.end || !values.output) throw new Error(`--start, --end and --output are required.\n\n${usage()}`);
  await runNativeScalarWalletExport({
    lower: values.start,
    upper: values.end,
    output: values.output,
    network: values.network,
    threads: Number(values.threads),
    chunkSize: Number(values['chunk-size']),
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli().catch((error) => {
    console.error(`Export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
