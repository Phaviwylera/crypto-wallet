import test from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS, SCOPE_CHECKLIST, PROGRAM_VERIFICATION_MAX_AGE_MS } from '../src/security/program-data.mjs';
import { officialProgramUrl, createCustomProgram, createProgramState, verificationStatus, reportReadiness, mergeProgramCatalog } from '../src/security/program-workflow.mjs';
import { loadWorkspace, saveWorkspace, clearWorkspace } from '../src/security/storage.mjs';
import { buildReport, reportMarkdown, reportHtml, emptyReportFields, buildEvidenceBundle, verifyEvidenceBundle, reproductionScript } from '../src/security/report.mjs';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { analyzeEntropy } from '../src/security/entropy-core.mjs';
import { generateEntropyFixture } from '../src/security/entropy-fixtures.mjs';
import { gzipSync } from 'node:zlib';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const verifiedState = () => ({ ...createProgramState('1inch-wallet', NOW), checked: Object.fromEntries(SCOPE_CHECKLIST.map((item) => [item.id, true])), verifiedAt: NOW });
const completeFields = () => ({ ...emptyReportFields(), title: 'Test report', asset: 'Own local fixture', impact: 'Demonstrated on synthetic data only', reproduction: 'Run fixture', remediation: 'Use CSPRNG', manualValidation: true, ownData: true, noExploit: true, novel: true });

async function fixtureReport() {
  const entropy = await analyzeEntropy(generateEntropyFixture('repeating', 4096), { label: 'fixture', compress: async (bytes) => new Uint8Array(gzipSync(bytes)), now: new Date(NOW).toISOString() });
  return buildReport({ fields: completeFields(), entropy, program: PROGRAMS[0], programState: verifiedState(), fixture: { id: 'repeating', bytes: 4096 }, now: new Date(NOW).toISOString() });
}

test('catalog distinguishes web/app ceilings from headline rewards and paused programs', () => {
  const ox = PROGRAMS.find((program) => program.id === '0x');
  assert.equal(ox.maxRewardUsd, 1000000);
  assert.equal(ox.webCriticalMaxUsd, 50000);
  assert.ok(PROGRAMS.find((program) => program.id === 'avalabs').status === 'observed-paused');
  assert.ok(PROGRAMS.find((program) => program.id === 'zerion').status === 'observed-paused');
  for (const program of PROGRAMS) assert.match(program.url, /^https:\/\/immunefi\.com\/bug-bounty\//);
});

test('custom program URLs must be official HTTPS Immunefi program pages', () => {
  assert.equal(officialProgramUrl('https://immunefi.com/bug-bounty/example/?x=1#top'), 'https://immunefi.com/bug-bounty/example/');
  for (const url of ['http://immunefi.com/bug-bounty/example/', 'https://evil.example/bug-bounty/example/', 'https://immunefi.com.evil.example/bug-bounty/example/', 'javascript:alert(1)', 'https://immunefi.com/rules/']) assert.throws(() => officialProgramUrl(url));
  const program = createCustomProgram({ name: 'Example', url: 'https://immunefi.com/bug-bounty/example/' });
  assert.equal(program.status, 'unverified');
  assert.equal(program.maxRewardUsd, null);
});

test('scope verification requires every checklist item and expires', () => {
  const program = PROGRAMS[0];
  assert.equal(verificationStatus(verifiedState(), program, NOW).ready, true);
  assert.equal(verificationStatus(verifiedState(), program, NOW + PROGRAM_VERIFICATION_MAX_AGE_MS + 1).ready, false);
  const partial = verifiedState(); partial.checked.asset = false;
  assert.equal(verificationStatus(partial, program, NOW).ready, false);
  assert.equal(verificationStatus(verifiedState(), PROGRAMS.find((item) => item.status === 'observed-paused'), NOW).ready, false);
});

test('report readiness blocks missing evidence, scope, fields and attestations', () => {
  const result = reportReadiness({ program: PROGRAMS[0], programState: verifiedState(), entropy: null, source: null, fields: emptyReportFields(), now: NOW });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.length >= 6);
});

test('source-only leads require manual validation', () => {
  const source = { findings: [{ ruleId: 'JS-MATH-RANDOM' }], summary: { findings: 1 } };
  const fields = completeFields(); fields.manualValidation = false;
  const result = reportReadiness({ program: PROGRAMS[0], programState: verifiedState(), entropy: null, source, fields, now: NOW });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((reason) => reason.includes('Source matches are leads')));
});

test('complete local checklist still produces draft-not-submitted status', async () => {
  const report = await fixtureReport();
  assert.equal(report.localReadiness.ready, true);
  assert.equal(report.status, 'draft-not-submitted');
  assert.ok(report.disclaimers.some((line) => line.includes('not been submitted')));
});

test('report markdown and HTML escape user content and include limitations', async () => {
  const report = await fixtureReport();
  report.fields.title = '<script>alert(1)</script>';
  const html = reportHtml(report);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(reportMarkdown(report).includes('DRAFT — NOT SUBMITTED'));
  assert.ok(reportMarkdown(report).includes('not certified entropy bounds'));
});

test('evidence bundle verifies and excludes raw sample bytes', async () => {
  const report = await fixtureReport();
  const coreSource = await readFile(new URL('../src/security/entropy-core.mjs', import.meta.url), 'utf8');
  const fixtureSource = await readFile(new URL('../src/security/entropy-fixtures.mjs', import.meta.url), 'utf8');
  const bundle = await buildEvidenceBundle(report, { coreSource, fixtureSource });
  const entries = unzipSync(bundle);
  const verified = await verifyEvidenceBundle(entries);
  assert.equal(verified.ok, true);
  assert.ok(entries['reproduce.mjs']);
  assert.ok(entries['entropy-core.mjs']);
  assert.equal(Object.keys(entries).some((name) => name.endsWith('.bin')), false);
  assert.ok(new TextDecoder().decode(entries['reproduce.mjs']).includes('generateEntropyFixture'));
});

test('tampered bundle fails integrity verification', async () => {
  const report = await fixtureReport();
  const coreSource = await readFile(new URL('../src/security/entropy-core.mjs', import.meta.url), 'utf8');
  const fixtureSource = await readFile(new URL('../src/security/entropy-fixtures.mjs', import.meta.url), 'utf8');
  const entries = unzipSync(await buildEvidenceBundle(report, { coreSource, fixtureSource }));
  entries['report.md'] = new TextEncoder().encode('tampered');
  await assert.rejects(verifyEvidenceBundle(entries), /Integrity check failed/);
});

test('external-sample reproduction requires the original file and checks digest', async () => {
  const report = await fixtureReport();
  report.evidence.syntheticFixture = null;
  const script = reproductionScript(report);
  assert.ok(script.includes('process.argv[2]'));
  assert.ok(script.includes('Digest mismatch'));
});

test('workspace storage persists only workflow metadata and recovers from corruption', () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const workspace = { version: 1, programs: { '1inch-wallet': verifiedState() }, customPrograms: [], selectedProgramId: '1inch-wallet' };
  saveWorkspace(workspace, storage);
  assert.deepEqual(loadWorkspace(storage).programs, workspace.programs);
  const serialized = JSON.stringify([...data.values()]);
  assert.equal(serialized.includes('histogram'), false);
  data.set('seedlab.security.workspace.v1', '{broken');
  assert.ok(loadWorkspace(storage).recoveryNotice);
  clearWorkspace(storage);
  assert.equal(data.size, 0);
});

test('custom catalog merge rejects duplicate built-in IDs', () => {
  const custom = createCustomProgram({ name: 'Example', url: 'https://immunefi.com/bug-bounty/example/' });
  const merged = mergeProgramCatalog([custom, custom, { ...custom, id: '1inch-wallet' }]);
  assert.equal(merged.length, PROGRAMS.length + 1);
});
