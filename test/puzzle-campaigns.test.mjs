import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPuzzleCampaignSnapshot,
  formatPuzzleCampaignPercent,
  puzzleCampaignContentMarkup,
  puzzleCampaignStatusMarkup,
  puzzleCampaignWorkRatio,
  PUZZLE_CAMPAIGN_IDS,
} from '../src/puzzle-campaigns.js';

function liveSnapshot() {
  const snapshot = createPuzzleCampaignSnapshot('RUNNING');
  snapshot.generatedAt = '2026-11-02T15:30:00.000Z';
  for (const campaign of snapshot.campaigns) {
    campaign.processAlive = true;
    campaign.pid = 4000 + campaign.id;
    campaign.done = '1000000000';
    campaign.total = '1000000000000000000000';
    campaign.ratePerSecond = 8_500_000;
    campaign.elapsedSeconds = 65;
    campaign.etaSeconds50 = 1e14;
  }
  return snapshot;
}

test('loading snapshot contains exactly the five real campaigns', () => {
  const snapshot = createPuzzleCampaignSnapshot();
  assert.deepEqual(snapshot.campaigns.map((campaign) => campaign.id), PUZZLE_CAMPAIGN_IDS);
  assert.ok(snapshot.campaigns.every((campaign) => campaign.state === 'LOADING'));
  assert.ok(snapshot.campaigns.every((campaign) => campaign.found === false));
});

test('main UI panel renders five live status cards and no toy demo controls', () => {
  const html = puzzleCampaignStatusMarkup({ snapshot: liveSnapshot() });
  assert.match(html, /id="campaign-status"/);
  assert.match(html, /ACTUAL CAMPAIGNS/);
  assert.equal((html.match(/class="campaign-card"/g) || []).length, 5);
  assert.match(html, /5 \/ 5/);
  assert.match(html, /PID 4140/);
  assert.doesNotMatch(html, /kangaroo-demo|run-kangaroo|SYNTHETIC TEST ONLY/);
});

test('tiny expected-work ratios stay scientific and are not artificially enlarged', () => {
  const campaign = liveSnapshot().campaigns[0];
  const ratio = puzzleCampaignWorkRatio(campaign);
  assert.equal(ratio, 1e-12);
  assert.equal(formatPuzzleCampaignPercent(ratio), '1.00e-10%');
  const html = puzzleCampaignContentMarkup({ snapshot: liveSnapshot() });
  assert.match(html, /1\.00e-10%/);
  assert.match(html, /width:1\.0000000000000002e-10%|width:1e-10%/);
});

test('errors are escaped and found counts do not expose scalar material', () => {
  const snapshot = liveSnapshot();
  snapshot.campaigns[0].found = true;
  snapshot.campaigns[0].state = 'FOUND';
  const html = puzzleCampaignContentMarkup({ snapshot, error: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /PRIVATE KEYS FOUND<\/span><b>1<\/b>/);
  assert.doesNotMatch(html, /FOUND\.txt|privateScalar|privateKey/);
});
