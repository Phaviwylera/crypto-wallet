import { BITCOIN_PUZZLES, getBitcoinPuzzle } from './bitcoin-puzzles.js';
import { parseSearchRange } from './search-range.js';

export const DEFAULT_NATIVE_CHUNK_SIZE = 10000000n;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function validateNativePuzzleInput(puzzleId, lower, upper) {
  const puzzle = getBitcoinPuzzle(Number(puzzleId));
  const range = parseSearchRange(String(lower).trim(), String(upper).trim());
  if (range.start < BigInt(puzzle.lower) || range.end > BigInt(puzzle.upper)) throw new Error(`The interval is outside puzzle #${puzzle.id}'s published bounds.`);
  return { puzzle, range };
}

export function firstNativePuzzleChunk(puzzleId, chunkSize = DEFAULT_NATIVE_CHUNK_SIZE) {
  const puzzle = getBitcoinPuzzle(Number(puzzleId));
  if (typeof chunkSize !== 'bigint' || chunkSize < 1n) throw new Error('Chunk size must be positive.');
  const lower = BigInt(puzzle.lower);
  const upper = BigInt(puzzle.upper);
  const end = lower + chunkSize - 1n;
  return { lower: lower.toString(), upper: (end < upper ? end : upper).toString() };
}

export function nextNativePuzzleChunk(puzzleId, lower, upper) {
  const { puzzle, range } = validateNativePuzzleInput(puzzleId, lower, upper);
  const start = range.end + 1n;
  const publishedEnd = BigInt(puzzle.upper);
  if (start > publishedEnd) throw new Error('The published puzzle range has already been reached.');
  const end = start + range.count - 1n;
  return { lower: start.toString(), upper: (end < publishedEnd ? end : publishedEnd).toString() };
}

export function createNativePuzzleState() {
  return {
    puzzleId: 71,
    ...firstNativePuzzleChunk(71),
    threads: '2',
    runner: null,
    jobs: [],
    loading: true,
    actionBusy: false,
    error: '',
    serverTime: null,
  };
}

export async function nativePuzzleRequest(action, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/native-puzzle/${action}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Native puzzle API HTTP ${response.status}`);
  if (!data || typeof data !== 'object') throw new Error('Native puzzle API returned an invalid response.');
  return data;
}

function formatInteger(value) {
  try {
    return BigInt(value || 0).toLocaleString('en-US');
  } catch {
    return '—';
  }
}

function formatRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return '—';
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} Gkeys/s`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(2)} Mkeys/s`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(2)} Kkeys/s`;
  return `${rate.toFixed(0)} keys/s`;
}

function progressPercent(job) {
  try {
    const done = BigInt(job.done || 0);
    const total = BigInt(job.total || 0);
    if (total <= 0n) return 0;
    return Number((done * 10000n) / total) / 100;
  } catch {
    return 0;
  }
}

function nativeJobMarkup(job) {
  const percent = progressPercent(job);
  const state = escapeHtml(job.state || 'UNKNOWN');
  return `<article class="native-puzzle-job" data-state="${state}">
    <div class="native-puzzle-job-heading"><div><b>Puzzle #${Number(job.puzzle)} · ${state}</b><code>${escapeHtml(job.campaign)}</code></div><strong>${percent.toFixed(4)}%</strong></div>
    <div class="native-puzzle-progress" role="progressbar" aria-label="Puzzle #${Number(job.puzzle)} native scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${Math.min(100, percent)}%"></span></div>
    <dl><div><dt>Checked</dt><dd>${formatInteger(job.done)} / ${formatInteger(job.total)}</dd></div><div><dt>Rate</dt><dd>${formatRate(job.ratePerSecond)}</dd></div><div><dt>Elapsed</dt><dd>${Number(job.elapsedSeconds || 0).toFixed(1)}s</dd></div><div><dt>Rejected</dt><dd>${Number(job.rejectedCandidates || 0)}</dd></div></dl>
    <p>Range <code>${escapeHtml(job.lower)}</code> to <code>${escapeHtml(job.upper)}</code></p>
    ${job.found ? '<p class="native-puzzle-found"><b>Matching scalar found.</b> Retrieve FOUND.txt from this campaign on the runner machine. Private key material is not exposed through this API.</p>' : ''}
    ${job.error ? `<p class="search-file-error" role="alert">${escapeHtml(job.error)}</p>` : ''}
    <div class="dlog-actions">${job.canStop ? `<button class="dlog-stop-button" type="button" data-native-action="stop" data-campaign="${escapeHtml(job.campaign)}">Stop and checkpoint</button>` : ''}${job.canResume ? `<button class="search-file-button" type="button" data-native-action="resume" data-campaign="${escapeHtml(job.campaign)}">Resume</button>` : ''}${job.state === 'COMPLETED' && !job.found ? '<span class="native-puzzle-complete">Completed without a match</span>' : ''}</div>
  </article>`;
}

export function nativePuzzleStatusMarkup(state) {
  const runner = state.runner;
  return `${state.loading ? '<p class="step-explanation">Checking for the native runner…</p>' : ''}
    ${runner ? `<p class="native-puzzle-runner ${runner.available ? 'available' : 'unavailable'}"><b>${runner.available ? `Native runner ready · ${escapeHtml(runner.version)}` : 'Native runner unavailable'}</b>${runner.reason ? `<br>${escapeHtml(runner.reason)}` : ''}</p>` : ''}
    ${state.error ? `<p class="search-file-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
    ${state.jobs.length ? `<div class="native-puzzle-jobs">${state.jobs.map(nativeJobMarkup).join('')}</div>` : '<p class="step-explanation subtle">No native scans have been started from this UI.</p>'}
    <p class="step-explanation subtle">Live status comes from pzsolve status files. Completed means only the displayed custom interval was covered. FOUND.txt is never returned by the HTTP API.</p>`;
}

export function nativePuzzleMarkup(state) {
  const active = state.jobs.some((job) => job.processAlive);
  let count = '—';
  try {
    count = parseSearchRange(state.lower, state.upper).count.toLocaleString('en-US');
  } catch {
    // The backend will show the validation error when Start is pressed.
  }
  return `<section class="backward-panel dlog-panel native-puzzle-panel" id="native-puzzle">
    <div class="backward-heading"><div><span class="eyebrow">OPTIONAL LOCAL BACKEND · NATIVE C</span><h3>Native pzsolve address scanner</h3></div><span class="live-example">AVX / SIMD · CHECKPOINTS</span></div>
    <p class="step-explanation">Runs the validated native pzsolve executable against built-in public Bitcoin Puzzle targets only. It uses the same custom inclusive ranges as the CLI, with no browser worker or candidate TXT overhead. One scan at a time; large full ranges remain infeasible.</p>
    <div class="candidate-range native-puzzle-inputs"><label>Public puzzle<select id="native-puzzle-id">${BITCOIN_PUZZLES.map((puzzle) => `<option value="${puzzle.id}" ${puzzle.id === state.puzzleId ? 'selected' : ''}>#${puzzle.id} · ${puzzle.status} snapshot</option>`).join('')}</select></label><label>CPU threads<input id="native-puzzle-threads" type="number" min="1" max="32" value="${escapeHtml(state.threads)}"></label></div>
    <div class="candidate-range"><label>Lower scalar (inclusive)<input id="native-puzzle-lower" type="text" inputmode="numeric" value="${escapeHtml(state.lower)}"></label><label>Upper scalar (inclusive)<input id="native-puzzle-upper" type="text" inputmode="numeric" value="${escapeHtml(state.upper)}"></label></div>
    <p class="step-explanation subtle">Current custom interval: <b>${count} candidates</b>. Next chunk advances by the same count without overlap. No subrange is claimed to be more likely.</p>
    <div class="dlog-actions"><button class="action-button" id="native-puzzle-start" type="button" data-native-action="start" ${state.actionBusy || active || state.runner?.available === false ? 'disabled' : ''}>${state.actionBusy ? 'Working…' : 'Start native scan'}<span aria-hidden="true">↗</span></button><button class="search-file-button" type="button" data-native-action="next" ${state.actionBusy ? 'disabled' : ''}>Load next chunk</button><button class="search-file-button" type="button" data-native-action="reset" ${state.actionBusy ? 'disabled' : ''}>Reset first chunk</button></div>
    <div id="native-puzzle-status" aria-live="polite">${nativePuzzleStatusMarkup(state)}</div>
  </section>`;
}
