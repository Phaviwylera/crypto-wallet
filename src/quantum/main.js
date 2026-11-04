import './style.css';
import { BASES, COUNT_QUBITS, TARGET_QUBITS, runShorSimulation } from './shor-core.js';

const app = document.querySelector('#quantum-app');
const state = { mode: 'browser', base: '', seed: '', shots: 128, maxAttempts: 5, result: null, busy: false, error: '', health: null, toast: '' };
const e = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (value, digits = 4) => value == null ? '—' : Number(value).toFixed(digits);

function toast(message, error = false) {
  document.querySelector('#toast')?.remove();
  const node = document.createElement('div');
  node.id = 'toast'; node.className = `toast${error ? ' error' : ''}`; node.setAttribute('role', error ? 'alert' : 'status'); node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 5000);
}
function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function options() {
  const seedText = state.seed.trim();
  const seed = seedText === '' ? null : Number(seedText);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF)) throw new Error('Seed must be empty or an integer from 0 through 4294967295.');
  return { base: state.base === '' ? null : Number(state.base), seed, shots: Number(state.shots), maxAttempts: Number(state.maxAttempts) };
}
function pythonCommand() {
  const o = options();
  return `.runtime/quantum-venv/bin/python scripts/shors_algorithm.py${o.base === null ? '' : ` --base ${o.base}`}${o.seed === null ? '' : ` --seed ${o.seed}`} --shots ${o.shots} --max-attempts ${o.maxAttempts}`;
}

function render() {
  const result = state.result;
  const success = result?.success;
  const lastPhase = result?.events?.filter((event) => event.type === 'phase').at(-1);
  const lastPeriod = result?.events?.filter((event) => event.type === 'period').at(-1);
  const attempts = result?.events?.filter((event) => event.type === 'attempt').length ?? 0;
  app.innerHTML = `<header class="topbar"><a class="brand" href="/"><span class="brand-mark">Ψ</span><span>SEEDLAB<small>QUANTUM LAB</small></span></a><nav class="nav" aria-label="Main navigation"><a href="/">Wallet lab</a><a href="/auditor.html">Security auditor</a><a class="active" href="/quantum.html" aria-current="page">Shor N=15</a></nav><span class="status"><i class="dot"></i>EDUCATIONAL SIMULATOR</span></header>
  <main class="content">
    <div class="hero"><div><span class="eyebrow">QUANTUM ALGORITHMS · COMPILED N=15 DEMO</span><h1>Shor’s algorithm,<br>one small integer at a time.</h1><p>Run the classical–quantum hybrid factoring pipeline for <strong>N = 15</strong> using either an exact browser statevector simulation or the local Qiskit Aer simulator. Inspect phase estimation, continued fractions, period validation and the final GCD step.</p></div><span class="chip">12 QUBITS · 8 COUNT + 4 TARGET</span></div>
    <div class="notice"><span>Ψ</span><span><strong>Educational scope only.</strong> This page factors the fixed integer 15. It accepts no addresses, public keys, private keys or wallet data, and does not run on quantum hardware. The compiled modular-multiplication circuit is specific to N=15 and is not a general factoring or ECC implementation.</span></div>
    ${state.error ? `<div class="notice error" role="alert"><span>!</span><span>${e(state.error)}</span></div>` : ''}
    <div class="metrics"><div class="metric"><label>FACTORS</label><strong class="lime">${success ? result.factors.join(' × ') : '—'}</strong><small>${success ? '15 = 3 × 5 verified' : 'Run an experiment'}</small></div><div class="metric"><label>VALIDATED PERIOD</label><strong class="violet">${lastPeriod?.period ?? '—'}</strong><small>${lastPeriod ? `a = ${lastPeriod.a}` : 'Order of a modulo 15'}</small></div><div class="metric"><label>MEASURED PHASE</label><strong class="cyan">${lastPhase ? fmt(lastPhase.phase, 6) : '—'}</strong><small>${lastPhase ? `bits ${lastPhase.bitstring}` : 's / r'}</small></div><div class="metric"><label>ATTEMPTS</label><strong>${attempts || '—'}</strong><small>${result ? result.backend : 'Hybrid pipeline'}</small></div></div>
    <div class="grid"><section class="panel"><div class="panel-head"><div><h3>Experiment controls</h3><p>Fixed modulus N=15. Choose a simulator and base.</p></div></div><div class="panel-body">
      <div class="modes" role="radiogroup" aria-label="Simulator backend">
        <label class="mode ${state.mode === 'browser' ? 'active' : ''}"><input type="radio" name="mode" value="browser" ${state.mode === 'browser' ? 'checked' : ''}><span><b>Browser statevector</b><small>Exact classical simulation of the 12-qubit circuit. Works on static hosting, no Python required.</small></span></label>
        <label class="mode ${state.mode === 'qiskit' ? 'active' : ''}"><input type="radio" name="mode" value="qiskit" ${state.mode === 'qiskit' ? 'checked' : ''}><span><b>Local Qiskit Aer</b><small>Runs the Python/Qiskit circuit through the optional local API. ${state.health ? (state.health.ok ? `Ready · Qiskit ${e(state.health.runner?.qiskit)}` : 'Not ready — run setup') : 'Setup: bash scripts/setup-shors-lab.sh'}</small></span></label>
      </div>
      <div class="field"><label for="base">Coprime base a</label><select id="base"><option value="">Auto (random each attempt)</option>${BASES.map((a) => `<option value="${a}" ${String(a) === state.base ? 'selected' : ''}>a = ${a}</option>`).join('')}</select><small>Allowed bases: 2, 4, 7, 8, 11, 13.</small></div>
      <div class="field-row"><div class="field"><label for="shots">Shots per attempt</label><select id="shots">${[1, 8, 32, 128, 1024].map((s) => `<option value="${s}" ${Number(state.shots) === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label for="attempts">Max attempts</label><select id="attempts">${[1, 2, 3, 5, 10].map((n) => `<option value="${n}" ${Number(state.maxAttempts) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
      <div class="field"><label for="seed">Seed (optional)</label><input id="seed" type="number" min="0" max="4294967295" step="1" placeholder="Random" value="${e(state.seed)}"><small>Use a fixed seed to reproduce a run.</small></div>
      <div class="button-row"><button class="button primary" id="run" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="busy"></span> Simulating…' : 'Run Shor experiment ↗'}</button><button class="button ghost" id="reset" ${state.busy ? 'disabled' : ''}>Reset</button></div>
      <div class="button-row" style="margin-top:10px"><button class="button small" id="export" ${!result ? 'disabled' : ''}>Export JSON</button><button class="button small" id="copy-command">Copy Python command</button></div>
    </div></section>
    <section class="panel"><div class="panel-head"><div><h3>Measurement evidence</h3><p>${result ? `${e(result.backend)} · ${result.shots} shot(s) · seed ${result.seed ?? 'random'}` : 'Phase-estimation output appears here.'}</p></div></div><div class="panel-body">
      ${result ? `<div class="result-banner ${success ? '' : 'fail'}"><div><label>${success ? 'NONTRIVIAL FACTORS FOUND' : 'NO FACTORS WITHIN ATTEMPT LIMIT'}</label><strong>${success ? 'Factorization verified' : 'Retry with another seed/base'}</strong></div><span class="equation">${success ? `${result.factors[0]} × ${result.factors[1]} = 15` : 'N = 15'}</span></div>${lastPhase ? histogram(lastPhase) : ''}<h3>Attempt timeline</h3><div class="timeline">${timeline(result)}</div>` : `<div class="empty"><div><div class="empty-icon" style="margin-inline:auto">Ψ</div><h3>Ready to simulate</h3><p>Choose a base or leave it on Auto, then run the experiment. The pipeline measures a phase, infers a period with continued fractions, validates it, and computes GCDs.</p></div></div>`}
    </div></section></div>
    <section class="panel" id="circuit"><div class="panel-head"><div><h3>Compiled phase-estimation circuit</h3><p>8 counting qubits + 4 target qubits. Controlled modular multiplication is compiled from SWAP/X gates for N=15.</p></div></div><div class="panel-body">${circuit()}</div></section>
    <section id="how"><div class="steps">${[['01', 'Classical setup', 'Choose a coprime base a. If gcd(a,15) is already nontrivial, return the factor classically. Otherwise prepare counting qubits in superposition and the target register in |1>.'], ['02', 'Quantum period finding', 'Apply controlled a^(2^q) mod 15 operations, then the inverse QFT. Measuring the counting register yields a phase approximating s/r, where r is the order of a modulo 15.'], ['03', 'Classical post-processing', 'Use continued fractions to propose r, validate a^r ≡ 1 mod 15, reject odd/trivial periods, then compute gcd(a^(r/2) ± 1, 15). Verify the product equals 15.']].map(([n, title, body]) => `<article class="step"><span>${n} / PIPELINE</span><h3>${title}</h3><p>${body}</p></article>`).join('')}</div></section>
    <section class="panel" style="margin-top:20px"><div class="panel-head"><div><h3>Run the Python/Qiskit version</h3><p>The same algorithm is executable from the repository root.</p></div></div><div class="panel-body"><code class="command">bash scripts/setup-shors-lab.sh\nnpm run quantum:shor -- --base 7 --seed 42 --shots 128\nnpm run server:quantum\nnpm run test:quantum</code><p>The setup script creates an isolated environment under <code>.runtime/quantum-venv</code> and installs pinned Qiskit/Aer dependencies. The browser statevector mode does not need Python. See <code>docs/shors-n15.md</code> for the full guide and corrections made to the original snippet.</p><ul class="limit-list"><li>Fixed N=15 only; other moduli are rejected.</li><li>Local simulator only; no quantum hardware, cloud credentials or wallet inputs.</li><li>Browser mode is a classical statevector simulation, clearly labeled as such.</li><li>The optional API binds to loopback by default and runs one simulation at a time.</li></ul></div></section>
    <footer class="footer"><span>SEEDLAB QUANTUM LAB · N=15 EDUCATIONAL DEMO</span><span>No wallet data · No quantum hardware · No key recovery</span></footer>
  </main>`;
}

function histogram(phaseEvent) {
  let probabilities = phaseEvent.probabilities;
  if (!probabilities && phaseEvent.counts) {
    probabilities = Array(256).fill(0);
    for (const [bits, count] of Object.entries(phaseEvent.counts)) probabilities[parseInt(bits, 2)] = count / phaseEvent.shots;
  }
  if (!probabilities) return '';
  const max = Math.max(...probabilities, 1e-9);
  const peaks = probabilities.map((p, value) => ({ value, p })).filter((item) => item.p > 0.01).sort((a, b) => b.p - a.p).slice(0, 8);
  return `<div class="field-label mono" style="font-size:10px;color:#8fa4b7">COUNTING-REGISTER PROBABILITY / FREQUENCY</div><div class="histogram" role="img" aria-label="Phase measurement distribution">${probabilities.map((p, value) => `<span style="height:${Math.max(p > 0 ? 2 : 0, p / max * 100)}%" title="phase ${value}/256: ${p.toFixed(4)}"></span>`).join('')}</div><div class="axis"><span>0</span><span>64</span><span>128</span><span>192</span><span>255</span></div>${peaks.length ? `<div class="table-wrap"><table><thead><tr><th>Value</th><th>Phase</th><th>Probability/frequency</th></tr></thead><tbody>${peaks.map((peak) => `<tr><td class="mono">${peak.value}</td><td class="mono">${peak.value}/256 = ${fmt(peak.value / 256, 6)}</td><td class="mono">${fmt(peak.p, 4)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function timeline(result) {
  const attempts = new Map();
  for (const event of result.events) {
    if (event.type === 'start' || event.type === 'failure' || event.type === 'success') continue;
    const id = event.attempt ?? 0;
    if (!attempts.has(id)) attempts.set(id, []);
    attempts.get(id).push(event);
  }
  return [...attempts.entries()].map(([id, events]) => {
    const attempt = events.find((x) => x.type === 'attempt');
    const phase = events.find((x) => x.type === 'phase');
    const period = events.find((x) => x.type === 'period');
    const check = events.find((x) => x.type === 'factor-check');
    const retry = events.find((x) => x.type === 'retry');
    const gcdEvent = events.find((x) => x.type === 'classical-gcd');
    const ok = check?.ok || gcdEvent;
    return `<article class="attempt"><div class="attempt-top"><b>Attempt ${id}${attempt ? ` · a = ${attempt.a}` : ''}</b><span class="pill ${ok ? 'ok' : retry ? 'retry' : 'info'}">${ok ? 'factors found' : retry ? retry.reason : 'measured'}</span></div>${gcdEvent ? `<p>Classical GCD found factors <code>${gcdEvent.factors.join(' × ')}</code>.</p>` : ''}${phase ? `<p>Measured bits <code>${e(phase.bitstring)}</code> → phase <code>${fmt(phase.phase, 6)}</code>.</p>` : ''}${period ? `<p>Continued fraction <code>${period.numerator}/${period.denominator}</code> → validated period <code>r = ${period.period ?? 'none'}</code>${period.method ? ` (${e(period.method)})` : ''}.</p>` : ''}${check ? `<p>${e(check.detail)}</p>` : ''}${retry && !check ? `<p>Retry: ${e(retry.reason)}.</p>` : ''}</article>`;
  }).join('');
}
function circuit() {
  const cols = ['H', ...Array.from({ length: 8 }, (_, i) => `U${2 ** i}`), 'QFT†', 'M'];
  let html = '<div class="circuit"><div class="circuit-grid"><div></div>' + cols.map((c) => `<div class="circuit-head">${c}</div>`).join('');
  for (let q = 0; q < COUNT_QUBITS; q++) {
    html += `<div class="circuit-label">q${q} (count)</div>`;
    html += `<div class="wire"><span class="gate h">H</span></div>`;
    for (let i = 0; i < 8; i++) html += `<div class="wire">${i === q ? `<span class="gate u">a^${2 ** i}</span>` : ''}</div>`;
    html += `<div class="wire"><span class="gate">QFT†</span></div><div class="wire"><span class="gate m">M</span></div>`;
  }
  for (let t = 0; t < TARGET_QUBITS; t++) {
    html += `<div class="circuit-label">t${t} (target)</div><div class="wire">${t === 0 ? '<span class="gate x">X</span>' : ''}</div>`;
    for (let i = 0; i < 8; i++) html += `<div class="wire">${t === 0 ? `<span class="gate u">•</span>` : ''}</div>`;
    html += '<div class="wire"></div><div class="wire"></div>';
  }
  return html + '</div></div><p style="font-size:10px;margin-top:12px">Conceptual layout: each controlled U^(2^q) acts on the full 4-qubit target register. The target is initialized to |0001⟩ = 1. Qiskit uses little-endian qubit ordering.</p>';
}

async function checkHealth() {
  try {
    const response = await fetch('/api/quantum/health', { cache: 'no-store' });
    state.health = await response.json();
  } catch { state.health = { ok: false, runner: { reason: 'API unavailable' } }; }
}
async function run() {
  state.error = ''; state.busy = true; render();
  try {
    const opts = options();
    if (state.mode === 'browser') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.result = runShorSimulation(opts);
    } else {
      await checkHealth();
      if (!state.health?.ok) throw new Error(state.health?.runner?.reason || 'Qiskit API unavailable. Run: bash scripts/setup-shors-lab.sh && npm run server:quantum');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 70000);
      try {
        const response = await fetch('/api/quantum/shor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ N: 15, ...opts }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `API returned ${response.status}`);
        state.result = data;
      } finally { clearTimeout(timer); }
    }
    toast(state.result.success ? `Factors found: ${state.result.factors.join(' × ')} = 15` : 'No factors within the attempt limit. Try another seed/base.');
  } catch (error) {
    state.error = error.name === 'AbortError' ? 'Simulation timed out.' : error.message;
    toast(state.error, true);
  } finally { state.busy = false; render(); }
}

app.addEventListener('change', (event) => {
  const target = event.target;
  if (target.name === 'mode') { state.mode = target.value; if (state.mode === 'qiskit') checkHealth().then(render); else render(); }
  else if (target.id === 'base') { state.base = target.value; }
  else if (target.id === 'shots') state.shots = target.value;
  else if (target.id === 'attempts') state.maxAttempts = target.value;
});
app.addEventListener('input', (event) => { if (event.target.id === 'seed') state.seed = event.target.value; });
app.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.id === 'run') await run();
  else if (button.id === 'reset') { state.result = null; state.error = ''; render(); }
  else if (button.id === 'export' && state.result) download('shor-n15-result.json', JSON.stringify(state.result, null, 2), 'application/json');
  else if (button.id === 'copy-command') {
    try { await navigator.clipboard.writeText(pythonCommand()); toast('Python command copied.'); } catch { toast('Clipboard unavailable. Copy the command from the setup panel.', true); }
  }
});
render();
