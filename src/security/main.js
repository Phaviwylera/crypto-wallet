import './style.css';
import { analyzeEntropy, RECOMMENDED_ENTROPY_BYTES } from './entropy-core.mjs';
import { ENTROPY_FIXTURES, generateEntropyFixture } from './entropy-fixtures.mjs';
import { readEntropyFile, decodeEntropyText } from './entropy-input.mjs';
import { scanSources, SOURCE_EXTENSIONS, SOURCE_LIMITS } from './source-scanner.mjs';
import { PROGRAM_SNAPSHOT_DATE, IMMUNEFI_RULES_URL, IMMUNEFI_EXPLORE_URL, IMMUNEFI_SUBMIT_URL, SCOPE_CHECKLIST, RESEARCH_REFERENCES } from './program-data.mjs';
import { createCustomProgram, createProgramState, mergeProgramCatalog, verificationStatus } from './program-workflow.mjs';
import { loadWorkspace, saveWorkspace, clearWorkspace } from './storage.mjs';
import { buildReport, reportMarkdown, reportHtml, emptyReportFields, buildEvidenceBundle, escapeHtml as e } from './report.mjs';
import coreSource from './entropy-core.mjs?raw';
import fixtureSource from './entropy-fixtures.mjs?raw';
import vulnerableExample from '../../examples/security/vulnerable-keygen.js?raw';
import secureExample from '../../examples/security/secure-keygen.js?raw';
import pythonExample from '../../examples/security/weak_seed.py?raw';

const app = document.querySelector('#auditor-app');
const stored = loadWorkspace();
const state = {
  tab: 'audit', workspace: stored, entropy: null, source: null, fixture: null,
  sample: null, sampleLabel: '', sampleFormat: 'binary', consent: false,
  fixtureId: 'repeating', fixtureBytes: 65536, busy: '', error: '', toast: stored.recoveryNotice ?? '',
  sourceFiles: [], sourceFilter: 'all', programFilter: 'all', programSearch: '',
  fields: emptyReportFields(), worker: null, exportBusy: false,
};
const TABS = [
  ['audit', '◈', 'Entropy auditor'], ['source', '⌘', 'Source review'], ['programs', '◎', 'Immunefi programs'], ['report', '▤', 'Report builder'], ['guide', '?', 'Research guide'],
];
const programs = () => mergeProgramCatalog(state.workspace.customPrograms);
const selectedProgram = () => programs().find((program) => program.id === state.workspace.selectedProgramId) ?? null;
const programState = (id) => state.workspace.programs[id] ?? createProgramState(id);
const money = (value) => value == null ? 'Not set' : `$${Number(value).toLocaleString('en-US')}`;
const fmt = (value, digits = 4) => value == null ? '—' : Number(value).toFixed(digits);
const pfmt = (value) => value == null ? '—' : Number(value) < 0.0001 ? Number(value).toExponential(2) : Number(value).toFixed(4);
const bytesLabel = (value) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} KiB`;

function persist() {
  try { saveWorkspace(state.workspace); } catch (error) { toast(error.message, true); }
}
function toast(message, error = false) {
  state.toast = message;
  document.querySelector('#toast')?.remove();
  const node = document.createElement('div');
  node.id = 'toast'; node.className = `toast${error ? ' error' : ''}`; node.setAttribute('role', error ? 'alert' : 'status'); node.textContent = message;
  document.body.append(node);
  setTimeout(() => { if (node.isConnected) node.remove(); }, 5000);
}
function download(name, contents, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function currentReport() {
  return buildReport({ fields: state.fields, entropy: state.entropy, source: state.source, program: selectedProgram(), programState: programState(state.workspace.selectedProgramId), fixture: state.fixture });
}
function setTab(tab) {
  state.tab = tab; state.error = ''; render();
  document.querySelector('#main-content')?.focus({ preventScroll: true });
}

function render() {
  const program = selectedProgram();
  app.innerHTML = `<div class="shell">
    <aside class="sidebar"><a class="brand" href="/"><span class="brand-mark">S</span><span>SEEDLAB<small>SECURITY AUDITOR</small></span></a><div class="nav-label">RESEARCH WORKSPACE</div><nav class="side-nav" aria-label="Auditor navigation">${TABS.map(([id, icon, label]) => `<button class="nav-button ${state.tab === id ? 'active' : ''}" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}${id === 'source' && state.source ? `<span class="nav-count">${state.source.summary.findings}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="privacy-card"><b>● Local-only analysis</b><p>No sample uploads. No balance checks. No private-key recovery. Workflow metadata stays in this browser.</p></div><a class="back-link" href="/">← Back to existing wallet lab</a><a class="back-link" href="/quantum.html">Ψ Quantum lab (Shor N=15) →</a></div></aside>
    <div class="main"><header class="topbar"><div class="breadcrumb">SEEDLAB <span class="muted">/</span> <b>${e(TABS.find(([id]) => id === state.tab)?.[2])}</b></div><div class="top-actions"><span class="top-status"><i class="status-dot"></i>OFFLINE ANALYSIS</span><button class="button small ghost" data-action="clear-workspace">Clear local data</button></div></header>
    <main class="content" id="main-content" tabindex="-1">
      <div class="page-head"><div><span class="eyebrow">DEFENSIVE SECURITY · RESPONSIBLE DISCLOSURE</span><h1>${pageTitle()}</h1><p>${pageDescription()}</p></div><span class="version-chip">AUDITOR 1.0.0</span></div>
      ${state.error ? `<div class="notice error" role="alert"><span>!</span><span>${e(state.error)}</span></div>` : ''}
      ${state.tab === 'audit' ? auditView() : state.tab === 'source' ? sourceView() : state.tab === 'programs' ? programsView(program) : state.tab === 'report' ? reportView() : guideView()}
      <footer class="footer"><span>SEEDLAB AUDITOR · NO THIRD-PARTY WALLET SEARCH</span><span>Program snapshot ${PROGRAM_SNAPSHOT_DATE} · Always verify official terms</span></footer>
    </main></div></div>`;
}
function pageTitle() {
  return { audit: 'Audit the randomness.<br>Not someone’s wallet.', source: 'Find the weak link<br>in key generation.', programs: 'Choose a program.<br>Respect the scope.', report: 'Turn evidence<br>into a clear report.', guide: 'Research that protects.<br>Evidence before impact.' }[state.tab];
}
function pageDescription() {
  return { audit: 'Test raw generator output for bias, repetition and predictability signals. Everything runs on this device, with reproducible evidence and explicit limits.', source: 'Static triage for weak RNG calls, predictable seeds and secret-handling mistakes. Scan authorized code you own or have permission to review.', programs: 'A sourced starting point for wallet-security bounties—not a live feed or permission to test. Track scope, exclusions and your own verification.', report: 'Combine redacted findings, sample digests and reproduction steps into a local draft. Nothing is submitted automatically; program terms and triage decide eligibility.', guide: 'A complete local workflow: collect authorized samples, trace the root cause, validate a fix and disclose responsibly. No funded-wallet hunting.' }[state.tab];
}
function metrics() {
  return `<div class="metrics"><div class="metric"><label>ENTROPY VERDICT</label><strong class="${state.entropy?.verdict === 'statistical-signal' ? '' : 'lime'}">${state.entropy ? state.entropy.verdict === 'statistical-signal' ? 'Signal detected' : state.entropy.verdict === 'review' ? 'Review' : 'No anomaly' : 'Not run'}</strong><small>${state.entropy ? `${state.entropy.summary.signals} signals · ${state.entropy.summary.reviews} review items` : 'Start with a synthetic control'}</small></div><div class="metric"><label>SOURCE FINDINGS</label><strong class="cyan">${state.source?.summary.findings ?? '—'}</strong><small>${state.source ? `${state.source.summary.filesScanned} files scanned · triage leads` : 'Static analysis, no code execution'}</small></div><div class="metric"><label>SELECTED PROGRAM</label><strong style="font-size:17px">${e(selectedProgram()?.name ?? 'None')}</strong><small>${e(selectedProgram()?.fit ?? 'Choose an official program')}</small></div><div class="metric"><label>REPORT READINESS</label><strong class="${currentReport().localReadiness.ready ? 'lime' : ''}">${currentReport().localReadiness.ready ? 'Checklist done' : 'Draft'}</strong><small>Local checks only · not submitted</small></div></div>`;
}
function auditView() {
  return `${metrics()}<div class="notice"><span class="notice-icon">◇</span><span><strong>Raw generator output only.</strong> Never paste a private key, recovery phrase, keystore or wallet export. A passing test does not prove cryptographic security; a signal does not prove exploitability.</span></div>
  <div class="grid-2"><section class="panel"><div class="panel-head"><div><h3>1. Choose a sample</h3><p>Run a safe fixture or import authorized generator output.</p></div><span class="panel-number">01 / INPUT</span></div><div class="panel-body">
    <div class="field"><label for="fixture-select">Synthetic training fixture</label><select id="fixture-select">${ENTROPY_FIXTURES.map((fixture) => `<option value="${fixture.id}" ${state.fixtureId === fixture.id ? 'selected' : ''}>${fixture.label}</option>`).join('')}</select><small>${e(ENTROPY_FIXTURES.find((fixture) => fixture.id === state.fixtureId)?.description)}</small></div>
    <div class="field-row"><div class="field"><label for="fixture-bytes">Sample size</label><select id="fixture-bytes">${[4096, 16384, 65536, 262144, 1048576].map((size) => `<option value="${size}" ${state.fixtureBytes === size ? 'selected' : ''}>${bytesLabel(size)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button class="button primary" data-action="run-fixture" ${state.busy ? 'disabled' : ''}>${state.busy === 'entropy' ? '<span class="busy"></span> Analyzing…' : 'Run synthetic audit ↗'}</button></div></div>
    <div class="divider"></div>
    <div class="field"><label for="sample-format">Import format</label><select id="sample-format">${[['binary', 'Binary (.bin / .raw)'], ['hex', 'Hex bytes'], ['base64', 'Base64 bytes'], ['json-bytes', 'JSON array of byte values']].map(([id, label]) => `<option value="${id}" ${state.sampleFormat === id ? 'selected' : ''}>${label}</option>`).join('')}</select><small>1 KiB minimum · 8 MiB maximum · 64 KiB recommended. Collect many fresh outputs, not one secret.</small></div>
    <label class="upload-zone" for="sample-file"><span class="upload-icon">⇧</span><strong>Choose an entropy sample</strong><small>Processed locally. Never uploaded or saved to browser storage.</small></label><input id="sample-file" type="file" accept=".bin,.raw,.hex,.txt,.json,.b64,application/octet-stream,text/plain,application/json">
    <details><summary>Or paste encoded bytes</summary><div class="field"><label for="sample-text">Encoded sample</label><textarea id="sample-text" spellcheck="false" placeholder="Hex, base64, or JSON bytes matching the selected format"></textarea></div><button class="button small" data-action="load-pasted">Load pasted sample</button></details>
    <label class="check-label"><input type="checkbox" id="sample-consent" ${state.consent ? 'checked' : ''}><span>This sample is synthetic, my own generator output, or explicitly authorized. It contains no wallet secret or third-party key material.</span></label>
    ${state.sample ? `<div class="file-summary">Loaded: ${e(state.sampleLabel)} · ${state.sample.length.toLocaleString()} bytes</div><div class="button-row" style="margin-top:12px"><button class="button primary" data-action="run-sample" ${!state.consent || state.busy ? 'disabled' : ''}>Analyze loaded sample ↗</button><button class="button ghost" data-action="clear-sample">Clear sample</button></div>` : ''}
  </div></section>
  <section class="panel"><div class="panel-head"><div><h3>2. Review the evidence</h3><p>Metadata only. Raw bytes never enter the report.</p></div><span class="panel-number">02 / RESULTS</span></div><div class="panel-body">${state.entropy ? entropyResults(state.entropy) : `<div class="empty"><div><div class="empty-icon" style="margin-inline:auto">◈</div><h3>Your evidence appears here</h3><p>Try the repeating-block fixture to see a strong signal, then compare the CSPRNG control and fixed-seed PRNG. The latter shows why statistics alone are insufficient.</p></div></div>`}</div></section></div>
  <section class="panel"><div class="panel-head"><div><h3>What the tests can—and cannot—tell you</h3><p>Interpretation is part of the audit.</p></div></div><div class="panel-body"><div class="guide-grid"><div><h3>Statistical signals</h3><p>Bit balance, runs, byte distribution, adjacent-byte correlation, bit-position bias, repeated blocks and gzip compression. Small p-values are triage signals, not severity ratings.</p></div><div><h3>Root-cause evidence</h3><p>Trace the actual RNG, seed source, state size, error paths and release-build flags. A fixed-seed PRNG can pass statistical tests while remaining completely predictable.</p></div><div><h3>Safe validation</h3><p>Reproduce on synthetic or explicitly authorized test wallets. Demonstrate the flaw and fix locally. Never search balances, access stranger accounts or move funds.</p></div></div></div></section>`;
}
function entropyResults(result) {
  const m = result.metrics;
  const max = Math.max(...m.bytes.histogram, 1);
  return `<div class="verdict ${result.verdict === 'statistical-signal' ? 'signal' : result.verdict === 'review' ? 'review' : ''}"><div><label>${e(result.input.label)}</label><strong>${result.verdict === 'statistical-signal' ? 'Statistical signal detected' : result.verdict === 'review' ? 'Review recommended' : 'No anomaly detected'}</strong></div><span class="verdict-score">${result.summary.signals}<small> signals</small></span></div>
  <div class="stat-grid"><div class="mini-stat"><label>Shannon entropy</label><b>${fmt(m.bytes.shannonBitsPerByte)}</b><small>bits/byte · empirical</small></div><div class="mini-stat"><label>Min-entropy estimate</label><b>${fmt(m.bytes.empiricalMinEntropyBitsPerByte)}</b><small>bits/byte · sample only</small></div><div class="mini-stat"><label>Byte chi-square p</label><b>${pfmt(m.bytes.pValue)}</b><small>255 degrees of freedom</small></div><div class="mini-stat"><label>Repeated 32B blocks</label><b>${m.blocks32.duplicateBlocks}</b><small>of ${m.blocks32.completeBlocks} blocks</small></div><div class="mini-stat"><label>Gzip ratio</label><b>${fmt(m.compression.ratio, 3)}</b><small>compressed / original</small></div><div class="mini-stat"><label>Sample size</label><b>${bytesLabel(result.input.bytes)}</b><small>${result.input.bytes.toLocaleString()} bytes</small></div></div>
  <div class="field-label">Byte frequency distribution</div><div class="histogram" role="img" aria-label="Histogram of all 256 byte values">${m.bytes.histogram.map((count, value) => `<span style="height:${Math.max(1, count / max * 100)}%" title="Byte ${value}: ${count}"></span>`).join('')}</div><div class="axis"><span>0x00</span><span>0x7F</span><span>0xFF</span></div>
  <div class="field-label">Ones proportion by bit position</div><div class="planes">${m.bitPlanes.map((plane) => `<div class="plane"><b>${(plane.proportion * 100).toFixed(1)}%</b><small>bit ${plane.plane}</small></div>`).join('')}</div>
  <div class="table-wrap"><table><thead><tr><th>Check</th><th>p-value</th><th>Result</th></tr></thead><tbody>${result.checks.map((check) => `<tr><td title="${e(check.detail)}">${e(check.label)}</td><td class="mono">${pfmt(check.pValue)}</td><td><span class="pill ${check.status}">${check.status}</span></td></tr>`).join('')}</tbody></table></div>
  <details><summary>Sample fingerprint and limitations</summary><p class="mono" style="overflow-wrap:anywhere">SHA-256: ${e(result.input.sha256)}</p><ul class="limit-list">${result.limitations.map((item) => `<li>${e(item)}</li>`).join('')}</ul></details>
  <div class="button-row"><button class="button small" data-action="download-entropy">Download JSON</button><button class="button small primary" data-tab="report">Add to report →</button></div>`;
}
function sourceView() {
  const findings = state.source?.findings.filter((finding) => state.sourceFilter === 'all' || finding.severity === state.sourceFilter) ?? [];
  return `${metrics()}<div class="notice warning"><span>!</span><span><strong>Static leads, not confirmed vulnerabilities.</strong> Uploaded code is never executed. Confirm data flow into secret generation, reproduce locally and check program scope before claiming impact.</span></div>
  <div class="grid-2"><section class="panel"><div class="panel-head"><div><h3>Authorized source input</h3><p>JavaScript AST + multi-language heuristic rules.</p></div><span class="panel-number">01 / CODE</span></div><div class="panel-body">
    <label class="upload-zone" for="source-files"><span class="upload-icon">⌘</span><strong>Choose source files or a ZIP</strong><small>Up to ${SOURCE_LIMITS.maxFiles} files · 1 MiB/file · 12 MiB total</small></label><input id="source-files" type="file" multiple accept="${SOURCE_EXTENSIONS.join(',')},.zip"><div class="file-summary">${state.sourceFiles.length ? `${state.sourceFiles.length} supported files loaded` : 'JS · TS · Python · Go · Rust · Java · Kotlin · Swift · Dart · C/C++ · Solidity'}</div>
    <div class="button-row" style="margin-top:15px"><button class="button primary" data-action="scan-files" ${!state.sourceFiles.length || state.busy ? 'disabled' : ''}>${state.busy === 'source' ? '<span class="busy"></span> Scanning…' : 'Scan loaded files ↗'}</button><button class="button" data-action="scan-demo" ${state.busy ? 'disabled' : ''}>Run training examples</button></div>
    <details><summary>Or paste a single source file</summary><div class="field"><label for="source-name">File name</label><input id="source-name" type="text" value="sample.js"></div><div class="field"><label for="source-text">Source code</label><textarea id="source-text" rows="8" spellcheck="false" placeholder="Paste only code you are authorized to review"></textarea></div><button class="button small" data-action="scan-pasted">Scan pasted code</button></details>
    <div class="divider"></div><h3>Coverage</h3><ul class="limit-list"><li>Weak PRNG calls and imports, clock-derived seeds, short secret buffers and possible hardcoded secrets.</li><li>Secure API references are recorded separately; they do not prove correct use.</li><li>Comments and most string contents are excluded from rule matching. Evidence lines are redacted.</li><li>No dependency resolution, binary inspection, full data-flow analysis or automatic exploit generation.</li></ul>
  </div></section><section class="panel"><div class="panel-head"><div><h3>Findings to investigate</h3><p>${state.source ? `${state.source.summary.filesScanned} scanned · ${state.source.summary.filesSkipped} skipped · ${state.source.summary.positiveObservations} secure-API references` : 'No source has been scanned yet.'}</p></div><span class="panel-number">02 / TRIAGE</span></div><div class="panel-body">
    ${state.source ? `<div class="toolbar"><select id="source-filter" aria-label="Filter finding severity">${['all', 'critical', 'high', 'medium', 'low'].map((severity) => `<option value="${severity}" ${state.sourceFilter === severity ? 'selected' : ''}>${severity === 'all' ? 'All severities' : severity}</option>`).join('')}</select><button class="button small" data-action="download-source">Export JSON</button><button class="button small primary" data-tab="report">Report →</button></div>${findings.length ? findings.map((finding) => `<article class="finding"><div class="finding-top"><span class="pill ${finding.severity}">${finding.severity}</span><small>${e(finding.ruleId)} · ${e(finding.confidence)} confidence</small></div><h4>${e(finding.title)}</h4><div class="finding-location">${e(finding.file)}:${finding.line}:${finding.column}</div><pre>${e(finding.evidence)}</pre><p>${e(finding.recommendation)}</p></article>`).join('') : '<div class="notice">No rule matches at this filter. This is not a clean bill of health.</div>'}${state.source.skipped.length ? `<details><summary>${state.source.skipped.length} skipped files</summary><ul class="limit-list">${state.source.skipped.map((file) => `<li>${e(file.name)} — ${e(file.reason)}</li>`).join('')}</ul></details>` : ''}` : `<div class="empty"><div><div class="empty-icon" style="margin-inline:auto">⌘</div><h3>Trace the source of every secret</h3><p>Run the training examples to compare an insecure Math.random fixture, a secure Web Crypto fixture and a Python random fixture.</p></div></div>`}
  </div></section></div>`;
}
function programsView(program) {
  const list = programs().filter((item) => (state.programFilter === 'all' || state.programFilter === 'active' && item.status === 'observed-active' || state.programFilter === 'wallet' && item.category.includes('Wallet') || state.programFilter === 'shortlisted' && programState(item.id).shortlisted) && `${item.name} ${item.category} ${item.fit}`.toLowerCase().includes(state.programSearch.toLowerCase()));
  const ps = program ? programState(program.id) : null;
  const verification = program ? verificationStatus(ps, program) : null;
  return `<div class="notice"><span class="notice-icon">◎</span><span><strong>Snapshot, not authorization.</strong> Retrieved ${PROGRAM_SNAPSHOT_DATE}. Status, rewards and scope can change. Open the official page before testing. Web/app ceilings below are not smart-contract headline rewards or guaranteed payouts.</span></div>
  ${program ? `<section class="scope-box"><div class="program-top"><div><span class="eyebrow">SELECTED PROGRAM</span><h3>${e(program.name)} · scope checkpoint</h3></div><span class="pill ${verification.ready ? 'ready' : 'review'}">${verification.ready ? 'Locally verified' : 'Verification required'}</span></div><p>${e(verification.reason)}</p><div class="scope-meta"><a class="button small" href="${e(program.url)}" target="_blank" rel="noopener noreferrer">Official terms ↗</a><a class="button small" href="${e(program.scopeUrl)}" target="_blank" rel="noopener noreferrer">Exact scope ↗</a><span class="pill">PoC ${program.pocRequired == null ? 'unknown' : program.pocRequired ? 'required' : 'check terms'}</span><span class="pill">KYC ${program.kycRequired == null ? 'unknown' : program.kycRequired ? 'required' : 'check terms'}</span></div>
    ${SCOPE_CHECKLIST.map((item) => `<label class="check-label"><input type="checkbox" data-scope-check="${item.id}" ${ps.checked[item.id] ? 'checked' : ''}><span>${e(item.label)}</span></label>`).join('')}
    <div class="field"><label for="program-notes">Private scope notes (no secrets)</label><textarea id="program-notes" rows="2" placeholder="Asset identifier, commit/build, relevant impact, deadline…">${e(ps.notes)}</textarea></div><div class="button-row"><button class="button primary small" data-action="verify-scope" ${program.status === 'observed-paused' ? 'disabled' : ''}>Record scope review</button><button class="button small" data-tab="report">Use in report →</button></div></section>` : ''}
  <div class="toolbar"><input id="program-search" type="text" placeholder="Search programs…" value="${e(state.programSearch)}" aria-label="Search programs"><select id="program-filter" aria-label="Filter programs">${[['all', 'All programs'], ['active', 'Observed active'], ['wallet', 'Wallet category'], ['shortlisted', 'Shortlisted']].map(([id, label]) => `<option value="${id}" ${state.programFilter === id ? 'selected' : ''}>${label}</option>`).join('')}</select><a class="button small" href="${IMMUNEFI_EXPLORE_URL}" target="_blank" rel="noopener noreferrer">Explore Immunefi ↗</a></div>
  <div class="program-grid">${list.map((item) => { const saved = programState(item.id); return `<article class="program-card ${item.id === state.workspace.selectedProgramId ? 'selected' : ''} ${item.status === 'observed-paused' ? 'paused' : ''}"><div class="program-top"><div class="program-logo">${e(item.name.slice(0, 1))}</div><span class="pill ${item.status === 'observed-paused' ? 'paused' : item.status === 'observed-active' ? 'active' : 'review'}">${item.status === 'observed-paused' ? 'Paused at snapshot' : item.status === 'observed-active' ? 'Active at snapshot' : 'Unverified'}</span></div><div><h3>${e(item.name)}</h3><p>${e(item.fit)}</p></div><div class="program-reward">${money(item.webCriticalMaxUsd)}<small>WEB/APP CRITICAL CEILING · SNAPSHOT</small></div><p>${e(item.keyGenerationNote)}</p><div class="program-tags"><span class="pill">${e(item.category)}</span><span class="pill">Primacy: ${e(item.primacy)}</span>${saved.shortlisted ? '<span class="pill ready">Shortlisted</span>' : ''}</div><div class="program-actions"><button class="button small ${item.id === state.workspace.selectedProgramId ? 'primary' : ''}" data-select-program="${e(item.id)}">${item.id === state.workspace.selectedProgramId ? 'Selected ✓' : 'Select program'}</button><button class="button small ghost" data-shortlist="${e(item.id)}">${saved.shortlisted ? 'Unshortlist' : 'Shortlist'}</button><a class="button small ghost" href="${e(item.url)}" target="_blank" rel="noopener noreferrer">Terms ↗</a></div></article>`; }).join('')}</div>${list.length ? '' : '<div class="empty"><p>No programs match this filter.</p></div>'}
  <section class="panel" style="margin-top:22px"><div class="panel-head"><div><h3>Add an official program</h3><p>Bookmarks only. Scope and rewards are never inferred automatically.</p></div></div><div class="panel-body"><div class="field-row"><div class="field"><label for="custom-name">Program name</label><input id="custom-name" type="text" maxlength="80" placeholder="Program name"></div><div class="field"><label for="custom-url">Official Immunefi URL</label><input id="custom-url" type="url" placeholder="https://immunefi.com/bug-bounty/program/"></div></div><button class="button small" data-action="add-program">Add unverified program</button></div></section>
  <section class="panel"><div class="panel-head"><div><h3>Selected program restrictions</h3><p>${e(program?.name ?? 'No program selected')}</p></div></div><div class="panel-body"><ul class="limit-list">${(program?.restrictions ?? ['Select a program to review its restrictions.']).map((item) => `<li>${e(item)}</li>`).join('')}</ul><p class="mono" style="font-size:10px">${e(program?.sourceNote ?? '')}</p></div></section>`;
}
function reportView() {
  const report = currentReport();
  const readiness = report.localReadiness;
  const field = (id, label, placeholder, multiline = true) => `<div class="field"><label for="report-${id}">${label}</label>${multiline ? `<textarea id="report-${id}" data-report-field="${id}" rows="${id === 'reproduction' ? 5 : 3}" placeholder="${e(placeholder)}">${e(state.fields[id])}</textarea>` : `<input id="report-${id}" data-report-field="${id}" type="text" value="${e(state.fields[id])}" placeholder="${e(placeholder)}">`}</div>`;
  return `<div class="notice warning"><span>!</span><span><strong>Draft only.</strong> This tool does not submit, contact projects, verify novelty or guarantee rewards. Complete manual root-cause validation and read the current official terms.</span></div><div class="grid-report"><section class="panel"><div class="panel-head"><div><h3>Report details</h3><p>Evidence attached: ${state.entropy ? 'entropy ✓' : 'entropy —'} · ${state.source ? 'source ✓' : 'source —'}</p></div><span class="panel-number">LOCAL DRAFT</span></div><div class="panel-body">
    <div class="field"><label for="report-program">Program</label><select id="report-program">${programs().map((program) => `<option value="${e(program.id)}" ${program.id === state.workspace.selectedProgramId ? 'selected' : ''}>${e(program.name)}${program.status === 'observed-paused' ? ' (paused at snapshot)' : ''}</option>`).join('')}</select></div>
    ${field('title', 'Title *', 'Weak entropy source in [exact component] allows [specific impact]', false)}${field('asset', 'Exact affected asset / version / commit *', 'Official in-scope asset and tested build identifier', false)}${field('rootCause', 'Root cause', 'Trace RNG → seed → secret generation. Explain the verified defect.')}${field('impact', 'Demonstrated security impact *', 'What security boundary fails, under which prerequisites, on your own test data?')}${field('reproduction', 'Reproduction steps *', '1. Use a synthetic or authorized local fixture…\n2. Run the documented command…\n3. Observe the specific failure…')}${field('remediation', 'Remediation *', 'Proposed fix, regression test, and affected-version guidance.')}${field('notes', 'Additional notes', 'Limitations, prior-art checks, and safe validation details.')}
    <div class="divider"></div><h3>Research attestations</h3>${[['manualValidation', 'I independently validated root cause and impact; scanner output alone is not my conclusion.'], ['ownData', 'Evidence uses my own data or explicit written authorization.'], ['noExploit', 'No third-party funds or accounts were accessed, harmed or searched.'], ['novel', 'I checked prior art and this is not an already-public or known issue.']].map(([id, label]) => `<label class="check-label"><input type="checkbox" data-report-field="${id}" ${state.fields[id] ? 'checked' : ''}><span>${label}</span></label>`).join('')}
  </div></section><div><section class="panel"><div class="panel-head"><div><h3>Submission readiness</h3><p>Your local checklist—not platform approval.</p></div></div><div class="panel-body"><div class="readiness ${readiness.ready ? 'ready' : ''}" id="readiness-box"><b>${readiness.ready ? 'Local checklist complete' : `${readiness.reasons.length} items remain`}</b><ul>${(readiness.ready ? ['Review the draft manually before submitting through the official dashboard.'] : readiness.reasons).map((reason) => `<li>${e(reason)}</li>`).join('')}</ul></div><div class="button-row"><button class="button primary" data-action="export-bundle" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? 'Building…' : 'Download evidence ZIP ↓'}</button><button class="button" data-action="export-markdown">Markdown</button><button class="button small" data-action="export-json">JSON</button><button class="button small" data-action="export-html">HTML</button></div><p style="margin-top:12px;font-size:10px">ZIP includes redacted reports, a SHA-256 manifest and executable Node reproduction for entropy evidence. Raw samples and full source are excluded.</p><a class="button small ghost" href="${IMMUNEFI_SUBMIT_URL}" target="_blank" rel="noopener noreferrer">Open official Immunefi dashboard ↗</a></div></section><section class="panel"><div class="panel-head"><div><h3>Live draft preview</h3><p>Updates as you type. Not persisted automatically.</p></div><button class="button small ghost" data-action="copy-report">Copy</button></div><div class="panel-body"><pre class="report-preview" id="report-preview">${e(reportMarkdown(report))}</pre></div></section></div></div>`;
}
function guideView() {
  return `<div class="guide-grid">${[['01', 'Define the boundary', 'Choose an active official program and exact asset. Read impacts, exclusions, known issues, PoC rules and deadlines. Use your own test data or written authorization.'], ['02', 'Collect clean evidence', 'Capture raw RNG output before hashing or key derivation. Record version, commit, platform, build flags and collection method. Never collect wallet secrets from other people.'], ['03', 'Trace and reproduce', 'Use source review to locate the defect. Reproduce on synthetic fixtures, confirm the data flow, test the fix and document prerequisites. Statistical anomalies alone are insufficient.'], ['04', 'Build the report', 'Attach redacted findings, sample digests, reproduction commands and remediation. State limitations honestly. Do not inflate severity or claim a reward ceiling.'], ['05', 'Disclose responsibly', 'Submit through the official program channel. Keep unpatched details private. Do not exploit, rescue funds, threaten, or bypass the dashboard. Follow KYC and publication terms.']].map(([step, title, body]) => `<article class="guide-card"><span class="step">${step} / WORKFLOW</span><h3>${title}</h3><p>${body}</p></article>`).join('')}</div>
  <section class="panel" style="margin-top:22px"><div class="panel-head"><div><h3>Run the complete local toolchain</h3><p>Node.js 22+ · no API keys · no network needed for analysis.</p></div></div><div class="panel-body"><code class="command">npm ci\nnpm run audit:demo\nnpm run audit:entropy -- ./sample.bin --out ./reports/entropy\nnpm run audit:source -- ./authorized-source --out ./reports/source\nnpm run audit:verify -- ./reports/audit-demo/bundle.zip\nnpm run test:security\nnpm run build</code><p>The demo creates JSON, Markdown, HTML and a verified ZIP bundle under <code>reports/audit-demo/</code>. See <code>docs/security-auditor.md</code> for the full execution and deployment guide.</p><div class="button-row"><button class="button small" data-action="copy-commands">Copy commands</button><button class="button small primary" data-action="scan-demo">Execute training source audit ↗</button></div></div></section>
  <section class="panel"><div class="panel-head"><div><h3>Primary references</h3><p>Historical incidents are learning material, not new bounty targets.</p></div></div><div class="panel-body">${RESEARCH_REFERENCES.map((reference) => `<div class="reference"><div><a href="${e(reference.url)}" target="_blank" rel="noopener noreferrer">${e(reference.title)} ↗</a><p>${e(reference.note)}</p></div></div>`).join('')}</div></section>
  <section class="panel"><div class="panel-head"><div><h3>Privacy and data handling</h3></div></div><div class="panel-body"><ul class="limit-list"><li>Entropy analysis runs in a browser worker; source analysis runs locally in the page. Neither uploads content.</li><li>Only program selections, checklist attestations and notes are saved to localStorage. Samples, source and report fields are memory-only.</li><li>Exports are created on your device. Entropy reports contain digests and metrics, not raw bytes. Source reports contain redacted lines, not full files.</li><li>External links open official sites only when you click them. There is no Immunefi login, token collection or automatic submission.</li><li>Clear local data removes saved workflow metadata and current in-memory evidence. Previously downloaded files remain on your disk.</li></ul><a href="${IMMUNEFI_RULES_URL}" target="_blank" rel="noopener noreferrer">Read the platform rules ↗</a></div></section>`;
}

async function runEntropy(bytes, label, format, fixture = null) {
  state.busy = 'entropy'; state.error = ''; render();
  try {
    let result;
    if (typeof Worker !== 'undefined') {
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./entropy-worker.js', import.meta.url), { type: 'module' });
        state.worker = worker;
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Analysis timed out. Try a smaller sample.')); }, 120000);
        worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); state.worker = null; data.ok ? resolve(data.result) : reject(new Error(data.error)); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); state.worker = null; reject(new Error('The local analysis worker failed. Try a smaller sample or the Node CLI.')); };
        const copy = bytes.slice();
        worker.postMessage({ buffer: copy.buffer, label, format }, [copy.buffer]);
      });
    } else result = await analyzeEntropy(bytes, { label, format });
    state.entropy = result; state.fixture = fixture;
    toast('Entropy audit complete. Evidence is ready for the report.');
  } catch (error) { state.error = error.message; }
  finally { state.busy = ''; render(); }
}
async function runSource(files) {
  state.busy = 'source'; state.error = ''; render();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.source = await scanSources(files); state.sourceFilter = 'all';
    toast(`${state.source.summary.filesScanned} files scanned. ${state.source.summary.findings} leads require manual triage.`);
  } catch (error) { state.error = error.message; }
  finally { state.busy = ''; render(); }
}
async function loadSourceFiles(fileList) {
  const files = [];
  let total = 0;
  for (const file of Array.from(fileList)) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      if (file.size > 4 * 1024 * 1024) throw new Error('ZIP limit is 4 MiB compressed.');
      const { unzipSync } = await import('fflate');
      let count = 0, expanded = 0;
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
        if (entry.name.endsWith('/')) return false;
        if (entry.name.startsWith('/') || entry.name.split('/').includes('..')) throw new Error('Unsafe ZIP path rejected.');
        if (++count > SOURCE_LIMITS.maxFiles || entry.originalSize > SOURCE_LIMITS.maxFileBytes || (expanded += entry.originalSize) > SOURCE_LIMITS.maxTotalBytes) throw new Error('ZIP exceeds the source scan limits.');
        return SOURCE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext));
      } });
      for (const [name, bytes] of Object.entries(entries)) files.push({ name, text: new TextDecoder().decode(bytes) });
    } else if (SOURCE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      if (file.size > SOURCE_LIMITS.maxFileBytes || (total += file.size) > SOURCE_LIMITS.maxTotalBytes) throw new Error('Source file or batch limit exceeded.');
      files.push({ name: file.webkitRelativePath || file.name, text: await file.text() });
    }
  }
  if (!files.length) throw new Error('No supported source files found.');
  if (files.length > SOURCE_LIMITS.maxFiles) throw new Error('Too many source files.');
  state.sourceFiles = files;
}
function updateReportPreview() {
  const report = currentReport();
  const preview = document.querySelector('#report-preview');
  if (preview) preview.textContent = reportMarkdown(report);
  const box = document.querySelector('#readiness-box');
  if (box) {
    const readiness = report.localReadiness;
    box.className = `readiness ${readiness.ready ? 'ready' : ''}`;
    box.innerHTML = `<b>${readiness.ready ? 'Local checklist complete' : `${readiness.reasons.length} items remain`}</b><ul>${(readiness.ready ? ['Review the draft manually before submitting through the official dashboard.'] : readiness.reasons).map((reason) => `<li>${e(reason)}</li>`).join('')}</ul>`;
  }
}
function updateProgramState(id, update) {
  const current = programState(id);
  state.workspace.programs[id] = { ...current, ...update, updatedAt: Date.now() };
  persist();
}

app.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { setTab(tab.dataset.tab); return; }
  const select = event.target.closest('[data-select-program]');
  if (select) { state.workspace.selectedProgramId = select.dataset.selectProgram; persist(); render(); return; }
  const shortlist = event.target.closest('[data-shortlist]');
  if (shortlist) { const id = shortlist.dataset.shortlist; updateProgramState(id, { shortlisted: !programState(id).shortlisted }); render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === 'run-fixture') {
      const bytes = generateEntropyFixture(state.fixtureId, state.fixtureBytes);
      await runEntropy(bytes, ENTROPY_FIXTURES.find((fixture) => fixture.id === state.fixtureId).label, 'synthetic', { id: state.fixtureId, bytes: state.fixtureBytes });
    } else if (action === 'run-sample') {
      if (!state.consent || !state.sample) throw new Error('Load an authorized sample and confirm the attestation.');
      await runEntropy(state.sample, state.sampleLabel, state.sampleFormat);
    } else if (action === 'load-pasted') {
      state.sample = decodeEntropyText(document.querySelector('#sample-text').value, state.sampleFormat);
      state.sampleLabel = 'Pasted authorized sample'; state.fixture = null; render(); toast('Sample loaded locally. Confirm authorization before analysis.');
    } else if (action === 'clear-sample') { state.sample = null; state.sampleLabel = ''; state.fixture = null; render(); }
    else if (action === 'scan-files') await runSource(state.sourceFiles);
    else if (action === 'scan-demo') { state.tab = 'source'; await runSource([{ name: 'vulnerable-keygen.js', text: vulnerableExample }, { name: 'secure-keygen.js', text: secureExample }, { name: 'weak_seed.py', text: pythonExample }]); }
    else if (action === 'scan-pasted') {
      const name = document.querySelector('#source-name').value.trim() || 'sample.js';
      const text = document.querySelector('#source-text').value;
      if (!text.trim()) throw new Error('Paste source code first.');
      await runSource([{ name, text }]);
    } else if (action === 'download-entropy') download('entropy-audit.json', JSON.stringify(state.entropy, null, 2), 'application/json');
    else if (action === 'download-source') download('source-audit.json', JSON.stringify(state.source, null, 2), 'application/json');
    else if (action === 'verify-scope') {
      const program = selectedProgram(); const ps = programState(program.id);
      if (program.status === 'observed-paused') throw new Error('This program was paused at snapshot.');
      const missing = SCOPE_CHECKLIST.filter((item) => !ps.checked[item.id]);
      if (missing.length) throw new Error(`Complete all ${SCOPE_CHECKLIST.length} scope checks first (${missing.length} remaining).`);
      updateProgramState(program.id, { verifiedAt: Date.now() }); render(); toast('Scope review recorded for 24 hours. This is your attestation, not platform approval.');
    } else if (action === 'add-program') {
      const program = createCustomProgram({ name: document.querySelector('#custom-name').value, url: document.querySelector('#custom-url').value });
      if (programs().some((item) => item.id === program.id)) throw new Error('That program is already listed.');
      if (state.workspace.customPrograms.length >= 30) throw new Error('Custom program limit reached.');
      state.workspace.customPrograms.push(program); state.workspace.selectedProgramId = program.id; persist(); render(); toast('Unverified program bookmark added. Read its official scope before testing.');
    } else if (action === 'export-bundle') {
      state.exportBusy = true; button.disabled = true; button.textContent = 'Building…';
      const bundle = await buildEvidenceBundle(currentReport(), { coreSource, fixtureSource });
      download('seedlab-research-evidence.zip', bundle, 'application/zip'); toast('Evidence ZIP downloaded. Raw samples and full source were excluded.');
    } else if (action === 'export-markdown') download('security-report.md', reportMarkdown(currentReport()), 'text/markdown;charset=utf-8');
    else if (action === 'export-json') download('security-report.json', JSON.stringify(currentReport(), null, 2), 'application/json');
    else if (action === 'export-html') download('security-report.html', reportHtml(currentReport()), 'text/html;charset=utf-8');
    else if (action === 'copy-report') { await navigator.clipboard.writeText(reportMarkdown(currentReport())); toast('Markdown draft copied.'); }
    else if (action === 'copy-commands') { await navigator.clipboard.writeText(document.querySelector('.command').textContent); toast('Commands copied.'); }
    else if (action === 'clear-workspace') {
      if (!confirm('Clear saved program metadata and all current in-memory evidence? Downloaded files are not deleted.')) return;
      state.worker?.terminate(); clearWorkspace();
      state.workspace = { version: 1, programs: {}, customPrograms: [], selectedProgramId: '1inch-wallet' };
      state.entropy = null; state.source = null; state.sample = null; state.sampleLabel = ''; state.fixture = null; state.sourceFiles = []; state.fields = emptyReportFields(); state.consent = false; state.busy = ''; state.error = ''; render(); toast('Local workspace cleared.');
    }
  } catch (error) { state.error = error.message; render(); toast(error.message, true); }
  finally { if (action === 'export-bundle') { state.exportBusy = false; if (state.tab === 'report') render(); } }
});
app.addEventListener('change', async (event) => {
  const target = event.target;
  try {
    if (target.id === 'fixture-select') { state.fixtureId = target.value; render(); }
    else if (target.id === 'fixture-bytes') state.fixtureBytes = Number(target.value);
    else if (target.id === 'sample-format') { state.sampleFormat = target.value; state.sample = null; render(); }
    else if (target.id === 'sample-consent') { state.consent = target.checked; const run = document.querySelector('[data-action="run-sample"]'); if (run) run.disabled = !state.consent || !!state.busy; }
    else if (target.id === 'sample-file' && target.files[0]) {
      state.sample = await readEntropyFile(target.files[0], state.sampleFormat); state.sampleLabel = target.files[0].name; state.fixture = null; render(); toast('Sample loaded locally. Confirm authorization before analysis.');
    } else if (target.id === 'source-files') { await loadSourceFiles(target.files); render(); toast(`${state.sourceFiles.length} source files loaded locally.`); }
    else if (target.id === 'source-filter') { state.sourceFilter = target.value; render(); }
    else if (target.id === 'program-filter') { state.programFilter = target.value; render(); }
    else if (target.id === 'report-program') { state.workspace.selectedProgramId = target.value; persist(); updateReportPreview(); }
    else if (target.dataset.scopeCheck) { const ps = programState(state.workspace.selectedProgramId); updateProgramState(ps.programId, { checked: { ...ps.checked, [target.dataset.scopeCheck]: target.checked }, verifiedAt: null }); render(); }
    else if (target.dataset.reportField && target.type === 'checkbox') { state.fields[target.dataset.reportField] = target.checked; updateReportPreview(); }
  } catch (error) { state.error = error.message; render(); toast(error.message, true); }
});
app.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.reportField && target.type !== 'checkbox') { state.fields[target.dataset.reportField] = target.value; updateReportPreview(); }
  else if (target.id === 'program-notes') updateProgramState(state.workspace.selectedProgramId, { notes: target.value.slice(0, 10000), verifiedAt: null });
  else if (target.id === 'program-search') {
    state.programSearch = target.value;
    const position = target.selectionStart; render(); const input = document.querySelector('#program-search'); input.focus(); input.setSelectionRange(position, position);
  }
});
window.addEventListener('pagehide', () => state.worker?.terminate());
render();
