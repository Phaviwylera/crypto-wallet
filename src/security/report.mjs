import { reportReadiness } from './program-workflow.mjs';
import { PROGRAM_SNAPSHOT_DATE, SCOPE_CHECKLIST } from './program-data.mjs';

export const REPORT_SCHEMA_VERSION = '1.0.0';
export const REPORT_FIELDS = ['title', 'asset', 'impact', 'reproduction', 'remediation', 'rootCause', 'notes'];
export function emptyReportFields() {
  return { title: '', asset: '', impact: '', reproduction: '', remediation: '', rootCause: '', notes: '', manualValidation: false, ownData: false, noExploit: false, novel: false };
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function text(value, fallback = 'Not provided.') {
  return String(value ?? '').trim() || fallback;
}
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

export function buildReport({ fields = emptyReportFields(), entropy = null, source = null, program = null, programState = null, fixture = null, now = new Date().toISOString() } = {}) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid report timestamp.');
  const cleanFields = Object.fromEntries(REPORT_FIELDS.map((key) => [key, String(fields[key] ?? '').slice(0, 20000)]));
  for (const key of ['manualValidation', 'ownData', 'noExploit', 'novel']) cleanFields[key] = Boolean(fields[key]);
  const readiness = reportReadiness({ program, programState, entropy, source, fields: cleanFields, now: timestamp });
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION, kind: 'wallet-security-research-report', createdAt: now,
    status: 'draft-not-submitted', localReadiness: readiness,
    program: program ? { id: program.id, name: program.name, url: program.url, scopeUrl: program.scopeUrl, snapshotStatus: program.status, snapshotDate: PROGRAM_SNAPSHOT_DATE, webCriticalMaxUsd: program.webCriticalMaxUsd, scopeAttestation: programState ? { checked: programState.checked ?? {}, verifiedAt: programState.verifiedAt ? new Date(programState.verifiedAt).toISOString() : null, checklist: SCOPE_CHECKLIST } : null } : null,
    fields: cleanFields,
    evidence: { entropy, source, syntheticFixture: fixture ? { id: fixture.id, bytes: fixture.bytes, seed: fixture.seed ?? null, purpose: 'Synthetic regression fixture; no wallet or third-party data.' } : null },
    disclaimers: [
      'This report was prepared locally and has not been submitted to Immunefi or any project.',
      'Statistical anomalies and static rule matches are triage evidence, not proof of exploitability, severity, novelty, scope, or reward eligibility.',
      'No third-party balances, addresses, private keys, or funded-wallet searches are part of this workflow.',
      'The official program terms at the time of testing and submission control. Reward ceilings are not promises.',
      'Raw entropy samples and complete source files are deliberately excluded from the report bundle.',
    ],
  };
  return report;
}

export function reportMarkdown(report) {
  const f = report.fields;
  const lines = [
    `# ${text(f.title, 'Wallet security research draft')}`, '',
    '> DRAFT — NOT SUBMITTED. Local readiness is a checklist, not program approval or a reward guarantee.', '',
    '## Program and scope', '',
    `- Program: ${report.program?.name ?? 'Not selected'}`,
    `- Official terms: ${report.program?.url ?? 'Not selected'}`,
    `- Official scope: ${report.program?.scopeUrl ?? 'Not selected'}`,
    `- Exact affected asset/version: ${text(f.asset)}`,
    `- Catalog snapshot: ${PROGRAM_SNAPSHOT_DATE}; reverify live terms before testing/submission.`,
    `- Local readiness: ${report.localReadiness.ready ? 'Checklist complete' : 'Incomplete'}`,
    ...report.localReadiness.reasons.map((reason) => `- [ ] ${reason}`), '',
    '## Summary and root cause', '', text(f.rootCause), '',
    '## Demonstrated security impact', '', text(f.impact), '',
    '## Reproduction steps', '', text(f.reproduction), '',
    '## Remediation', '', text(f.remediation), '',
  ];
  if (report.evidence.entropy) {
    const e = report.evidence.entropy;
    lines.push('## Entropy evidence', '', `- Sample: ${e.input.label}`, `- Raw bytes: ${e.input.bytes}`, `- SHA-256: ${e.input.sha256}`, `- Verdict: ${e.verdict}`, `- Signals: ${e.summary.signals}; review items: ${e.summary.reviews}`, '', '| Check | Result | p-value |', '| --- | --- | --- |', ...e.checks.map((check) => `| ${check.label} | ${check.status} | ${check.pValue == null ? '—' : check.pValue.toExponential(4)} |`), '', ...e.limitations.map((item) => `- ${item}`), '');
  }
  if (report.evidence.source) {
    const s = report.evidence.source;
    lines.push('## Source review evidence', '', `- Files scanned: ${s.summary.filesScanned}; skipped: ${s.summary.filesSkipped}`, `- Rule matches: ${s.summary.findings}; these are leads, not confirmed vulnerabilities.`, '', '| Severity | Rule | Location | Evidence (redacted) |', '| --- | --- | --- | --- |', ...s.findings.map((finding) => `| ${finding.severity} | ${finding.ruleId} | ${finding.file}:${finding.line} | ${finding.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '', ...s.limitations.map((item) => `- ${item}`), '');
  }
  if (report.evidence.syntheticFixture) lines.push('## Synthetic fixture', '', `\`${report.evidence.syntheticFixture.id}\`, ${report.evidence.syntheticFixture.bytes} bytes. No wallet is derived. Run \`node reproduce.mjs\` from the extracted bundle.`, '');
  lines.push('## Research attestations', '', ...[['manualValidation', 'Root cause and impact independently validated'], ['ownData', 'Own data or explicit written authorization'], ['noExploit', 'No third-party funds/accounts accessed or harmed'], ['novel', 'Not an already-public or known issue']].map(([key, label]) => `- [${f[key] ? 'x' : ' '}] ${label}`), '', '## Additional notes', '', text(f.notes, 'None.'), '', '## Disclosure boundaries', '', ...report.disclaimers.map((item) => `- ${item}`), '');
  return lines.join('\n');
}

export function reportHtml(report) {
  const body = reportMarkdown(report).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(report.fields.title || 'Wallet security research draft')}</title><style>body{max-width:960px;margin:48px auto;padding:0 24px;background:#0b111b;color:#dce7f3;font:15px/1.65 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{color:#b8f36b}</style></head><body><pre>${body}</pre></body></html>`;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function reproductionScript(report) {
  const fixture = report.evidence.syntheticFixture;
  const entropy = report.evidence.entropy;
  return `#!/usr/bin/env node\n// Offline reproduction. No wallet derivation, network calls, or third-party data.\nimport { readFile } from 'node:fs/promises';\nimport { gzipSync } from 'node:zlib';\nimport { analyzeEntropy } from './entropy-core.mjs';\n${fixture ? "import { generateEntropyFixture } from './entropy-fixtures.mjs';\n" : ''}const expected = ${JSON.stringify(entropy?.input.sha256 ?? null)};\n${fixture ? `const bytes = generateEntropyFixture(${JSON.stringify(fixture.id)}, ${fixture.bytes}${fixture.seed != null ? `, { seed: ${fixture.seed} }` : ''});` : "if (!process.argv[2]) { console.error('Usage: node reproduce.mjs /path/to/your-original-sample.bin'); process.exit(2); }\nconst bytes = new Uint8Array(await readFile(process.argv[2]));"}\nconst result = await analyzeEntropy(bytes, { label: 'Reproduction', compress: async (value) => new Uint8Array(gzipSync(value)) });\nconsole.log(JSON.stringify(result, null, 2));\nif (expected && result.input.sha256 !== expected) { console.error('Digest mismatch: this is not the original sample.'); process.exit(1); }\nconsole.error(expected ? 'Digest matched. Compare metrics; CSPRNG controls require a fresh sample and will not match.' : 'No original digest was attached.');\n`;
}

export async function buildEvidenceBundle(report, { coreSource, fixtureSource } = {}) {
  const { zipSync, strToU8 } = await import('fflate');
  const files = {
    'report.json': strToU8(json(report)),
    'report.md': strToU8(reportMarkdown(report)),
    'report.html': strToU8(reportHtml(report)),
    'README.txt': strToU8('LOCAL RESEARCH DRAFT — NOT SUBMITTED\n\nReview official program terms before testing or submission. This bundle contains redacted findings and sample metadata, never raw entropy or complete source files.\n\nFor a synthetic fixture: node reproduce.mjs\nFor an external sample: node reproduce.mjs /path/to/original.bin\n\nNode.js 22+ required. No npm install or network access is needed for reproduction. entropy-core.mjs and entropy-fixtures.mjs are the exact auditor runtime sources.\n'),
  };
  if (report.evidence.entropy) {
    if (!coreSource || !fixtureSource) throw new Error('Auditor runtime sources are required for a reproducible entropy bundle.');
    files['entropy-core.mjs'] = strToU8(coreSource);
    files['entropy-fixtures.mjs'] = strToU8(fixtureSource);
    files['reproduce.mjs'] = strToU8(reproductionScript(report));
  }
  const manifest = { schemaVersion: '1.0.0', createdAt: report.createdAt, algorithm: 'SHA-256', files: {} };
  for (const [name, bytes] of Object.entries(files)) manifest.files[name] = { bytes: bytes.length, sha256: await sha256(bytes) };
  files['manifest.json'] = strToU8(json(manifest));
  return zipSync(files, { level: 6 });
}

export async function verifyEvidenceBundle(entries) {
  const decoder = new TextDecoder();
  if (!entries['manifest.json']) throw new Error('Bundle has no manifest.json.');
  const manifest = JSON.parse(decoder.decode(entries['manifest.json']));
  if (manifest.schemaVersion !== '1.0.0' || manifest.algorithm !== 'SHA-256') throw new Error('Unsupported bundle manifest.');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = entries[name];
    if (!(bytes instanceof Uint8Array)) throw new Error(`Missing bundle file: ${name}`);
    if (bytes.length !== expected.bytes || await sha256(bytes) !== expected.sha256) throw new Error(`Integrity check failed: ${name}`);
  }
  const report = JSON.parse(decoder.decode(entries['report.json']));
  if (report.kind !== 'wallet-security-research-report' || report.status !== 'draft-not-submitted') throw new Error('Unexpected report type/status.');
  return { ok: true, filesVerified: Object.keys(manifest.files).length, report };
}
