import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { createPuzzleStatusServer, PUZZLE_IDS } from '../scripts/puzzle-status-server.mjs';

async function fixture(t, records = {}) {
  const campaignRoot = await mkdtemp(path.join(os.tmpdir(), 'puzzle-status-'));
  for (const [id, record] of Object.entries(records)) {
    const directory = path.join(campaignRoot, `p${id}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'status.json'), JSON.stringify(record.status));
    if (record.pid) await writeFile(path.join(directory, 'lock'), `${record.pid}\n`);
  }

  const server = createPuzzleStatusServer({ campaignRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(campaignRoot, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

function runningStatus(overrides = {}) {
  return {
    puzzle: 140,
    campaign: 'p140',
    mode: 'kangaroo',
    state: 'RUNNING',
    unit: 'steps',
    done: '123456789',
    total: '884892601270575989760',
    rate_per_second: 8765432.1,
    rate_cpu: 8765432.1,
    rate_gpu: 0,
    elapsed_seconds: 42.5,
    eta_seconds_50: 1.0e14,
    updated_unix: 1793632500,
    found: false,
    rejected_candidates: 0,
    ...overrides,
  };
}

test('serves the dashboard and reports only live lock PIDs as running', async (t) => {
  const base = await fixture(t, {
    140: { status: runningStatus(), pid: process.pid },
    145: { status: runningStatus({ puzzle: 145, campaign: 'p145' }), pid: 99999999 },
  });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Kangaroo campaign monitor/);
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inlineScript, 'dashboard inline script is present');
  new Script(inlineScript[1]);

  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json();
  assert.equal(snapshot.campaigns.length, 5);
  assert.deepEqual(snapshot.campaigns.map((campaign) => campaign.id), PUZZLE_IDS);

  const live = snapshot.campaigns[0];
  assert.equal(live.state, 'RUNNING');
  assert.equal(live.processAlive, true);
  assert.equal(live.done, '123456789');
  assert.equal(live.total, '884892601270575989760');
  assert.equal(live.pid, process.pid);

  const stale = snapshot.campaigns[1];
  assert.equal(stale.state, 'STOPPED');
  assert.equal(stale.reportedState, 'RUNNING');
  assert.equal(stale.processAlive, false);

  assert.deepEqual(snapshot.campaigns.slice(2).map((campaign) => campaign.state), [
    'NOT_STARTED',
    'NOT_STARTED',
    'NOT_STARTED',
  ]);
  assert.equal('privateKey' in live, false);
  assert.equal('workers' in live, false);
});

test('preserves found state without exposing a result file', async (t) => {
  const base = await fixture(t, {
    140: { status: runningStatus({ state: 'COMPLETED', found: true }) },
  });
  const snapshot = await (await fetch(`${base}/api/status`)).json();
  assert.equal(snapshot.campaigns[0].state, 'FOUND');
  assert.equal(snapshot.campaigns[0].found, true);
  assert.equal(snapshot.campaigns[0].processAlive, false);
});

test('handles HEAD, missing routes, and unsupported methods', async (t) => {
  const base = await fixture(t);
  const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  assert.equal((await fetch(`${base}/missing`)).status, 404);
  const post = await fetch(`${base}/api/status`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});
