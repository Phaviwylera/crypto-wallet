#!/usr/bin/env node
/** Offline wallet-security auditor CLI. No network, wallet derivation, or balance lookup. */
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { analyzeEntropy } from '../src/security/entropy-core.mjs';
import { readEntropyFile } from '../src/security/entropy-input.mjs';
import { generateEntropyFixture, ENTROPY_FIXTURES } from '../src/security/entropy-fixtures.mjs';
import { scanSources, SOURCE_EXTENSIONS, SOURCE_LIMITS } from '../src/security/source-scanner.mjs';
import { buildReport, reportMarkdown, reportHtml, buildEvidenceBundle, verifyEvidenceBundle } from '../src/security/report.mjs';
import { PROGRAMS, PROGRAM_SNAPSHOT_DATE } from '../src/security/program-data.mjs';

const HELP = `Seedlab Security Auditor 1.0.0 — offline, authorized research only

Usage:
  node scripts/security-audit.mjs demo [--out reports/audit-demo]
  node scripts/security-audit.mjs entropy <sample.bin> [--format binary|hex|base64|json-bytes] [--out reports/entropy]
  node scripts/security-audit.mjs source <file-or-directory> [--out reports/source]
  node scripts/security-audit.mjs verify <bundle.zip>
  node scripts/security-audit.mjs programs [--json]

No API keys or network access are needed. Reports exclude raw entropy and full source.
A statistical signal or static rule match is not a confirmed vulnerability or bounty.
`;
const IGNORED = new Set(['node_modules', '.git', '.runtime', 'dist', 'build', 'coverage', 'exports', 'reports', '__pycache__', '.venv']);

async function collectSources(target) {
  const files = [];
  let totalBytes = 0;
  async function visit(current) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (IGNORED.has(path.basename(current))) return;
      const entries = await readdir(current);
      entries.sort();
      for (const entry of entries) await visit(path.join(current, entry));
    } else if (info.isFile() && SOURCE_EXTENSIONS.includes(path.extname(current).toLowerCase())) {
      if (info.size > SOURCE_LIMITS.maxFileBytes) throw new Error(`${current} exceeds the 1 MiB per-file limit.`);
      if (files.length >= SOURCE_LIMITS.maxFiles) throw new Error('Source file count limit reached.');
      totalBytes += info.size;
      if (totalBytes > SOURCE_LIMITS.maxTotalBytes) throw new Error('Source batch exceeds the 12 MiB limit.');
      files.push({ name: path.relative(path.dirname(target), current).split(path.sep).join('/'), text: await readFile(current, 'utf8') });
    }
  }
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  await visit(resolved);
  if (!files.length) throw new Error('No supported source files found. Supported: ' + SOURCE_EXTENSIONS.join(' '));
  // For a single file, use its basename rather than ../filename.
  if (info.isFile()) files[0].name = path.basename(resolved);
  return files;
}

async function writeOutputs(out, report, entropy, source) {
  await mkdir(out, { recursive: true });
  const coreSource = await readFile(new URL('../src/security/entropy-core.mjs', import.meta.url), 'utf8');
  const fixtureSource = await readFile(new URL('../src/security/entropy-fixtures.mjs', import.meta.url), 'utf8');
  const bundle = await buildEvidenceBundle(report, { coreSource, fixtureSource });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(out, 'report.md'), reportMarkdown(report));
  await writeFile(path.join(out, 'report.html'), reportHtml(report));
  await writeFile(path.join(out, 'bundle.zip'), bundle);
  if (entropy) await writeFile(path.join(out, 'entropy-audit.json'), JSON.stringify(entropy, null, 2) + '\n');
  if (source) await writeFile(path.join(out, 'source-audit.json'), JSON.stringify(source, null, 2) + '\n');
  const verified = await verifyEvidenceBundle(unzipSync(bundle));
  console.log(`Wrote ${path.resolve(out)}`);
  console.log(`  report.json / report.md / report.html / bundle.zip`);
  console.log(`  Bundle integrity verified: ${verified.filesVerified} files`);
  console.log('  DRAFT — NOT SUBMITTED. No raw entropy or full source included.');
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { console.log(HELP); return; }
  if (command === 'programs') {
    const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean', default: false } } });
    if (values.json) console.log(JSON.stringify({ snapshotDate: PROGRAM_SNAPSHOT_DATE, programs: PROGRAMS }, null, 2));
    else {
      console.log(`Official-page snapshot ${PROGRAM_SNAPSHOT_DATE}; reverify before testing. Web/app ceilings, not guarantees.`);
      for (const program of PROGRAMS) console.log(`${program.name}\t${program.status}\tweb/app critical max: ${program.webCriticalMaxUsd ?? 'unknown'} USD\t${program.url}`);
    }
    return;
  }
  if (command === 'verify') {
    if (!argv[0]) throw new Error('Usage: verify <bundle.zip>');
    const bytes = new Uint8Array(await readFile(argv[0]));
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Bundle exceeds 20 MiB.');
    let count = 0, expanded = 0;
    const entries = unzipSync(bytes, { filter: (entry) => {
      if (entry.name.startsWith('/') || entry.name.split('/').includes('..')) throw new Error('Unsafe ZIP path.');
      if (++count > 30 || (expanded += entry.originalSize) > 40 * 1024 * 1024) throw new Error('Bundle expansion limit exceeded.');
      return !entry.name.endsWith('/');
    } });
    const result = await verifyEvidenceBundle(entries);
    console.log(`OK: ${result.filesVerified} file digests verified. Report remains a local draft, not a validity or scope endorsement.`);
    return;
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string' }, format: { type: 'string', default: 'binary' } } });
  const out = values.out ?? `reports/audit-${command}`;
  const compress = async (bytes) => new Uint8Array(gzipSync(bytes));
  if (command === 'demo') {
    const repeating = await analyzeEntropy(generateEntropyFixture('repeating', 65536), { label: 'Synthetic repeating-block fixture', compress });
    const control = await analyzeEntropy(generateEntropyFixture('csprng', 65536), { label: 'Synthetic CSPRNG control', compress });
    const predictable = await analyzeEntropy(generateEntropyFixture('mt19937', 65536), { label: 'Synthetic fixed-seed MT19937', compress });
    const exampleDir = new URL('../examples/security/', import.meta.url);
    const source = await scanSources(await Promise.all(['vulnerable-keygen.js', 'secure-keygen.js', 'weak_seed.py'].map(async (name) => ({ name, text: await readFile(new URL(name, exampleDir), 'utf8') }))));
    const report = buildReport({
      fields: { title: 'Synthetic auditor demonstration — not a vulnerability report', asset: 'Local training fixtures only; no production asset', impact: 'No real-world impact demonstrated. This is a tooling demonstration.', rootCause: 'Intentionally weak synthetic generators and source fixtures exercise the auditor.', reproduction: '1. npm ci\n2. npm run audit:demo\n3. npm run audit:verify -- ./reports/audit-demo/bundle.zip\n4. Extract bundle.zip and run node reproduce.mjs', remediation: 'For real secret generation, use a platform CSPRNG, check errors, remove weak fallbacks and add regression tests.' },
      entropy: repeating, source, fixture: { id: 'repeating', bytes: 65536 },
    });
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'controls.json'), JSON.stringify({ control, predictable, note: 'The fixed-seed PRNG illustrates why statistical tests cannot establish seed secrecy. The CSPRNG control is fresh on each run.' }, null, 2) + '\n');
    await writeOutputs(out, report, repeating, source);
    console.log(`Demo: ${repeating.summary.signals} repeating-block signals; ${source.summary.findings} source leads; ${ENTROPY_FIXTURES.length} fixture types available.`);
    return;
  }
  if (command === 'entropy') {
    if (!positionals[0]) throw new Error('Usage: entropy <sample-file> [--format binary|hex|base64|json-bytes]');
    const file = await readFile(positionals[0]);
    const bytes = await readEntropyFile({ size: file.length, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), text: async () => file.toString('utf8') }, values.format);
    const entropy = await analyzeEntropy(bytes, { label: path.basename(positionals[0]), format: values.format, compress });
    const report = buildReport({ fields: { title: `Entropy triage — ${path.basename(positionals[0])}` }, entropy });
    await writeOutputs(out, report, entropy, null);
    console.log(`Verdict: ${entropy.verdict}; ${entropy.summary.signals} signals; ${entropy.summary.reviews} review items.`);
    return;
  }
  if (command === 'source') {
    if (!positionals[0]) throw new Error('Usage: source <file-or-directory>');
    const source = await scanSources(await collectSources(positionals[0]));
    const report = buildReport({ fields: { title: 'Authorized source triage — manual validation required' }, source });
    await writeOutputs(out, report, null, source);
    console.log(`Scanned ${source.summary.filesScanned} files; ${source.summary.findings} leads; ${source.summary.filesSkipped} skipped.`);
    return;
  }
  throw new Error(`Unknown command: ${command}. Run with --help.`);
}

main().catch((error) => { console.error(`Audit failed: ${error.message}`); process.exitCode = 1; });
