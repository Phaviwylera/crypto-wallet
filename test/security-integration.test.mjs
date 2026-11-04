import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const run = (args) => execFileSync(process.execPath, ['scripts/security-audit.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 60000 });

test('CLI demo writes reproducible outputs and a verifiable bundle', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'seedlab-audit-test-'));
  const output = run(['demo', '--out', out]);
  assert.match(output, /Bundle integrity verified/);
  for (const name of ['report.json', 'report.md', 'report.html', 'bundle.zip', 'entropy-audit.json', 'source-audit.json', 'controls.json']) assert.ok(existsSync(path.join(out, name)), name);
  const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.status, 'draft-not-submitted');
  assert.equal(report.evidence.entropy.verdict, 'statistical-signal');
  assert.ok(report.evidence.source.summary.findings >= 3);
  assert.match(run(['verify', path.join(out, 'bundle.zip')]), /OK: 7 file digests verified/);
});

test('CLI rejects unknown commands and missing inputs without network access', () => {
  assert.throws(() => run(['unknown']), /Unknown command/);
  assert.throws(() => run(['entropy']), /Usage: entropy/);
  assert.throws(() => run(['source']), /Usage: source/);
});

test('multi-page build config, Vercel rewrites and existing-lab link are additive', () => {
  const vite = readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  assert.match(vite, /auditor: new URL\('\.\/auditor\.html'/);
  assert.match(vite, /main: new URL\('\.\/index\.html'/);
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.deepEqual(vercel.rewrites[0], { source: '/auditor', destination: '/auditor.html' });
  assert.deepEqual(vercel.rewrites.at(-1), { source: '/(.*)', destination: '/index.html' });
  const main = readFileSync(path.join(root, 'src/main.js'), 'utf8');
  assert.match(main, /href="\/auditor\.html">Security auditor/);
  const html = readFileSync(path.join(root, 'auditor.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /src\/security\/main\.js/);
});

test('production Node server serves the auditor entry without a new backend', async () => {
  const dist = path.join(root, 'dist/auditor.html');
  if (!existsSync(dist)) return; // build is verified separately in CI
  const { createApp } = await import('../server/index.js');
  const app = createApp();
  const response = await app.request('/auditor.html');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Seedlab Auditor/);
});
