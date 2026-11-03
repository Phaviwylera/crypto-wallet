import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getBitcoinPuzzle } from '../src/bitcoin-puzzles.js';
import { parseSearchRange } from '../src/search-range.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_BIN = process.env.PZSOLVE_BIN || path.join(ROOT, '.runtime', 'bin', 'pzsolve');
const CAMPAIGN_ROOT = process.env.NATIVE_PUZZLE_CAMPAIGN_ROOT || path.join(ROOT, '.runtime', 'native-puzzle-campaigns');
const REGISTRY_ROOT = process.env.NATIVE_PUZZLE_REGISTRY_ROOT || path.join(ROOT, '.runtime', 'native-puzzle-registry');
const children = new Map();
let launchInFlight = false;
let runnerCache = { checkedAt: 0, value: null };

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(response, statusCode, value, method = 'GET') {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    'content-security-policy': "default-src 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : body);
}

async function readJsonBody(request) {
  let size = 0;
  let text = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw apiError('Request body is too large.', 413);
    text += chunk;
  }
  try {
    const value = text ? JSON.parse(text) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw apiError('Request body must be a JSON object.');
  }
}

export function validateNativePuzzleRange(puzzleId, lower, upper) {
  const puzzle = getBitcoinPuzzle(Number(puzzleId));
  const range = parseSearchRange(String(lower ?? '').trim(), String(upper ?? '').trim());
  if (range.start < BigInt(puzzle.lower) || range.end > BigInt(puzzle.upper)) {
    throw apiError(`The requested interval is outside puzzle #${puzzle.id}'s published bounds.`);
  }
  return { puzzle, range };
}

function normalizeThreads(value) {
  const threads = value === undefined ? Math.min(2, os.availableParallelism?.() || 1) : Number(value);
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw apiError('Threads must be an integer from 1 through 32.');
  return threads;
}

export function nativeCampaignName(puzzleId, range) {
  const digest = createHash('sha256').update(`${puzzleId}:${range.start}:${range.end}`).digest('hex').slice(0, 16);
  return `p${puzzleId}-${digest}`;
}

export function buildNativeHuntArgs(job, resume = false) {
  return [
    'hunt', '-p', String(job.puzzle),
    '-r', `${BigInt(job.lower).toString(16)}:${BigInt(job.upper).toString(16)}`,
    '--mode', 'linear', '--no-gpu', '--threads', String(job.threads), '--no-tune',
    '--dir', CAMPAIGN_ROOT, '--campaign', job.campaign, resume ? '--resume' : '--new',
    '--ui', 'log', '--checkpoint-interval', '5',
  ];
}

async function runnerInfo(force = false) {
  if (!force && runnerCache.value && Date.now() - runnerCache.checkedAt < (runnerCache.value.available ? 30000 : 5000)) return runnerCache.value;
  let value;
  try {
    if (!existsSync(RUNNER_BIN)) throw new Error('not installed');
    const { stdout } = await execFileAsync(RUNNER_BIN, ['--version'], { timeout: 4000, maxBuffer: 16384 });
    const version = String(stdout).split('\n')[0].trim();
    if (!/^pzsolve \d+\./.test(version)) throw new Error('unexpected version output');
    value = { available: true, version, reason: '' };
  } catch {
    value = {
      available: false,
      version: '',
      reason: 'Native pzsolve is not installed. Run npm run puzzle:native:setup in the Seedlab workspace, then restart the UI server.',
    };
  }
  runnerCache = { checkedAt: Date.now(), value };
  return value;
}

function registryFile(campaign) {
  if (!/^p\d+-[0-9a-f]{16}$/.test(campaign)) throw apiError('Invalid native campaign name.');
  return path.join(REGISTRY_ROOT, `${campaign}.json`);
}

async function readJob(campaign) {
  try {
    return JSON.parse(await readFile(registryFile(campaign), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw apiError('Native campaign was not found.', 404);
    throw error;
  }
}

async function saveJob(job) {
  await mkdir(REGISTRY_ROOT, { recursive: true });
  const destination = registryFile(job.campaign);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function campaignLockAlive(campaign) {
  try {
    const pid = Number((await readFile(path.join(CAMPAIGN_ROOT, campaign, 'lock'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifiedExternalCampaignPid(campaign) {
  if (process.platform !== 'linux') return null;
  try {
    const pid = Number((await readFile(path.join(CAMPAIGN_ROOT, campaign, 'lock'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    process.kill(pid, 0);
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const directoryIndex = args.indexOf('--dir');
    const campaignIndex = args.indexOf('--campaign');
    if (path.basename(args[0] || '') !== 'pzsolve' || args[1] !== 'hunt') return null;
    if (directoryIndex < 0 || path.resolve(args[directoryIndex + 1] || '') !== path.resolve(CAMPAIGN_ROOT)) return null;
    if (campaignIndex < 0 || args[campaignIndex + 1] !== campaign) return null;
    return pid;
  } catch {
    return null;
  }
}

async function publicJob(job) {
  const raw = await readJsonIfPresent(path.join(CAMPAIGN_ROOT, job.campaign, 'status.json'));
  const owned = children.has(job.campaign);
  const lockAlive = owned || await campaignLockAlive(job.campaign);
  let state = String(job.state || raw?.state || 'UNKNOWN').toUpperCase();
  if (raw?.found === true) state = 'FOUND';
  else if (state === 'STOPPING' && lockAlive) state = 'STOPPING';
  else if (owned && ['RUNNING', 'STARTING'].includes(state)) state = String(job.state).toUpperCase();
  else if (lockAlive && raw?.state) state = String(raw.state).toUpperCase();
  else if (!lockAlive && ['RUNNING', 'STARTING', 'STOPPING'].includes(state)) state = 'STOPPED';
  const found = raw?.found === true || state === 'FOUND';
  return {
    campaign: job.campaign,
    puzzle: job.puzzle,
    address: getBitcoinPuzzle(job.puzzle).address,
    lower: job.lower,
    upper: job.upper,
    state,
    done: String(raw?.done ?? (state === 'COMPLETED' || found ? job.count : '0')),
    total: String(raw?.total ?? job.count),
    ratePerSecond: Number(raw?.rate_per_second) || 0,
    elapsedSeconds: Number(raw?.elapsed_seconds) || 0,
    found,
    rejectedCandidates: Number(raw?.rejected_candidates) || 0,
    processAlive: lockAlive,
    ownedByThisServer: owned,
    canStop: owned || (lockAlive && process.platform === 'linux'),
    canResume: !lockAlive && !found && state !== 'COMPLETED',
    error: job.lastError || '',
    lastExitCode: job.lastExitCode ?? null,
    updatedAt: job.updatedAt,
  };
}

async function listJobs(limit = 50) {
  let names = [];
  try {
    names = await readdir(REGISTRY_ROOT);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const jobs = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const job = await readJob(name.slice(0, -5));
      jobs.push(await publicJob(job));
    } catch {
      // Ignore a partially replaced or unrelated registry entry.
    }
  }
  const sorted = jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

async function launch(job, resume) {
  if (launchInFlight || children.size) throw apiError('Another native scan is already running in this UI server. Stop it before starting another.', 409);
  launchInFlight = true;
  try {
    const active = (await listJobs(0)).find((candidate) => candidate.processAlive);
    if (active) throw apiError(`Native campaign ${active.campaign} is still running. Stop it before starting another.`, 409);
    const campaignDirectory = path.join(CAMPAIGN_ROOT, job.campaign);
    await mkdir(campaignDirectory, { recursive: true });
    const log = createWriteStream(path.join(campaignDirectory, 'seedlab-runner.log'), { flags: 'a', mode: 0o600 });
    const child = spawn(RUNNER_BIN, buildNativeHuntArgs(job, resume), {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(job.campaign, { child, log });
    child.stdout.on('data', (chunk) => log.write(chunk));
    child.stderr.on('data', (chunk) => log.write(chunk));
    log.on('error', (error) => { job.lastError = error.message; });
    job.state = 'RUNNING';
    job.updatedAt = new Date().toISOString();
    job.lastExitCode = null;
    job.lastError = '';
    const initialSave = saveJob(job);

    child.once('error', (error) => {
      job.lastError = error.message;
    });
    child.once('close', (code, signal) => {
      children.delete(job.campaign);
      log.end();
      job.lastExitCode = code;
      job.updatedAt = new Date().toISOString();
      if (code === 0) job.state = 'FOUND';
      else if (code === 1) job.state = 'COMPLETED';
      else if (code === 130 || signal === 'SIGTERM' || signal === 'SIGINT') job.state = 'STOPPED';
      else job.state = 'ERROR';
      if (job.state === 'ERROR' && !job.lastError) job.lastError = 'pzsolve exited with an error; inspect seedlab-runner.log on the runner machine.';
      initialSave.catch(() => {}).then(() => saveJob(job).catch(() => {}));
    });
    await initialSave;
  } finally {
    launchInFlight = false;
  }
}

async function statusHandler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    throw apiError('Method not allowed.', 405);
  }
  const [runner, jobs] = await Promise.all([runnerInfo(), listJobs()]);
  sendJson(response, 200, {
    runner,
    jobs,
    activeCampaign: jobs.find((job) => job.processAlive)?.campaign ?? null,
    serverTime: new Date().toISOString(),
  }, request.method);
}

async function startHandler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    throw apiError('Method not allowed.', 405);
  }
  const body = await readJsonBody(request);
  const { puzzle, range } = validateNativePuzzleRange(body.puzzle, body.lower, body.upper);
  const runner = await runnerInfo();
  if (!runner.available) throw apiError(runner.reason, 503);
  const campaign = nativeCampaignName(puzzle.id, range);
  if (existsSync(registryFile(campaign))) throw apiError('This exact range already has a native campaign. Resume it or load the next chunk.', 409);
  const now = new Date().toISOString();
  const job = {
    campaign,
    puzzle: puzzle.id,
    lower: range.start.toString(),
    upper: range.end.toString(),
    count: range.count.toString(),
    threads: normalizeThreads(body.threads),
    state: 'STARTING',
    createdAt: now,
    updatedAt: now,
    lastExitCode: null,
    lastError: '',
  };
  await saveJob(job);
  try {
    await launch(job, false);
  } catch (error) {
    if (error.statusCode === 409) {
      await rm(registryFile(campaign), { force: true });
    } else {
      job.state = 'ERROR';
      job.lastError = error.message;
      await saveJob(job);
    }
    throw error;
  }
  sendJson(response, 202, { ok: true, job: await publicJob(job) });
}

async function resumeHandler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    throw apiError('Method not allowed.', 405);
  }
  const body = await readJsonBody(request);
  const job = await readJob(String(body.campaign || ''));
  const current = await publicJob(job);
  if (current.found || current.state === 'COMPLETED') throw apiError('A completed range cannot be resumed; load the next chunk.', 409);
  if (current.processAlive) throw apiError('This campaign is already running.', 409);
  const runner = await runnerInfo();
  if (!runner.available) throw apiError(runner.reason, 503);
  await launch(job, true);
  sendJson(response, 202, { ok: true, job: await publicJob(job) });
}

async function stopHandler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    throw apiError('Method not allowed.', 405);
  }
  const body = await readJsonBody(request);
  const campaign = String(body.campaign || '');
  registryFile(campaign);
  const active = children.get(campaign);
  const externalPid = active ? null : await verifiedExternalCampaignPid(campaign);
  if (!active && !externalPid) throw apiError('No verified live pzsolve process was found for that campaign.', 409);
  const job = await readJob(campaign);
  job.state = 'STOPPING';
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  if (active) active.child.kill('SIGTERM');
  else process.kill(externalPid, 'SIGTERM');
  sendJson(response, 202, { ok: true, job: await publicJob(job) });
}

function wrap(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (response.headersSent) return;
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Native puzzle API failed.' });
    }
  };
}

export function nativePuzzleApi() {
  const register = (server) => {
    server.httpServer?.once('close', () => {
      for (const { child } of children.values()) child.kill('SIGTERM');
    });
    server.middlewares.use('/api/native-puzzle/status', wrap(statusHandler));
    server.middlewares.use('/api/native-puzzle/start', wrap(startHandler));
    server.middlewares.use('/api/native-puzzle/resume', wrap(resumeHandler));
    server.middlewares.use('/api/native-puzzle/stop', wrap(stopHandler));
  };
  return {
    name: 'native-puzzle-api',
    configureServer: register,
    configurePreviewServer: register,
  };
}
