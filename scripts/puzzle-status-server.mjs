import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUZZLE_IDS = Object.freeze([140, 145, 150, 155, 160]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_CAMPAIGN_ROOT = path.join(REPOSITORY_ROOT, '.runtime', 'pzsolve-campaigns');
const PAGE_URL = new URL('./puzzle-status-page.html', import.meta.url);

const RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

function send(response, statusCode, body, contentType, method = 'GET') {
  const payload = Buffer.from(body);
  response.writeHead(statusCode, {
    ...RESPONSE_HEADERS,
    'content-length': payload.length,
    'content-type': contentType,
  });
  response.end(method === 'HEAD' ? undefined : payload);
}

function sendJson(response, statusCode, value, method = 'GET') {
  send(response, statusCode, JSON.stringify(value), 'application/json; charset=utf-8', method);
}

async function readLock(campaignDirectory) {
  try {
    const text = await readFile(path.join(campaignDirectory, 'lock'), 'utf8');
    const pid = Number(text.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unavailableCampaign(id, state = 'NOT_STARTED') {
  return {
    id,
    campaign: `p${id}`,
    state,
    mode: 'kangaroo',
    unit: 'steps',
    done: '0',
    total: '0',
    ratePerSecond: 0,
    elapsedSeconds: 0,
    etaSeconds50: null,
    found: false,
    rejectedCandidates: 0,
    processAlive: false,
    pid: null,
    statusUpdatedUnix: null,
  };
}

export async function readCampaignStatus(campaignRoot, id, nowUnix = Date.now() / 1000) {
  const campaignDirectory = path.join(campaignRoot, `p${id}`);
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(campaignDirectory, 'status.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return unavailableCampaign(id);
    return unavailableCampaign(id, 'UNAVAILABLE');
  }

  const pid = await readLock(campaignDirectory);
  const processAlive = processIsAlive(pid);
  let state = String(raw.state || 'UNKNOWN').toUpperCase();
  if (raw.found) state = 'FOUND';
  else if (state === 'RUNNING' && !processAlive) state = 'STOPPED';

  return {
    id,
    campaign: `p${id}`,
    state,
    reportedState: raw.state,
    mode: raw.mode || 'kangaroo',
    unit: raw.unit || 'steps',
    done: String(raw.done ?? '0'),
    total: String(raw.total ?? '0'),
    ratePerSecond: Number(raw.rate_per_second) || 0,
    rateCpu: Number(raw.rate_cpu) || 0,
    rateGpu: Number(raw.rate_gpu) || 0,
    elapsedSeconds: Number(raw.elapsed_seconds) || 0,
    etaSeconds50: Number.isFinite(Number(raw.eta_seconds_50)) ? Number(raw.eta_seconds_50) : null,
    found: raw.found === true,
    rejectedCandidates: Number(raw.rejected_candidates) || 0,
    processAlive,
    pid,
    statusUpdatedUnix: Number(raw.updated_unix) || null,
    statusAgeSeconds: Number(raw.updated_unix) ? Math.max(0, nowUnix - Number(raw.updated_unix)) : null,
  };
}

export async function getStatusSnapshot(campaignRoot = DEFAULT_CAMPAIGN_ROOT) {
  const nowUnix = Date.now() / 1000;
  const campaigns = await Promise.all(PUZZLE_IDS.map((id) => readCampaignStatus(campaignRoot, id, nowUnix)));
  return {
    generatedAt: new Date().toISOString(),
    campaigns,
  };
}

export function createPuzzleStatusServer({ campaignRoot = DEFAULT_CAMPAIGN_ROOT } = {}) {
  const page = readFile(PAGE_URL, 'utf8');

  return createServer(async (request, response) => {
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendJson(response, 405, { error: 'Method not allowed.' }, method);
      return;
    }

    const url = new URL(request.url || '/', 'http://status.internal');
    try {
      if (url.pathname === '/api/status') {
        sendJson(response, 200, await getStatusSnapshot(campaignRoot), method);
        return;
      }
      if (url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true }, method);
        return;
      }
      if (url.pathname === '/') {
        send(response, 200, await page, 'text/html; charset=utf-8', method);
        return;
      }
      sendJson(response, 404, { error: 'Not found.' }, method);
    } catch {
      sendJson(response, 500, { error: 'Unable to read campaign status.' }, method);
    }
  });
}

async function main() {
  const port = Number(process.env.PORT || 4174);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 through 65535.');

  const server = createPuzzleStatusServer();
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    console.log(`Puzzle status dashboard listening on 0.0.0.0:${address.port}`);
    console.log(`Reading ${DEFAULT_CAMPAIGN_ROOT}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
