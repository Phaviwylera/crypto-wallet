export const PUZZLE_CAMPAIGN_IDS = Object.freeze([140, 145, 150, 155, 160]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function safeState(value) {
  const state = String(value || 'UNKNOWN').toUpperCase();
  return /^[A-Z_]+$/.test(state) ? state : 'UNKNOWN';
}

function emptyCampaign(id, state) {
  return {
    id,
    campaign: `p${id}`,
    state,
    mode: 'kangaroo',
    done: '0',
    total: '0',
    ratePerSecond: 0,
    elapsedSeconds: 0,
    etaSeconds50: null,
    found: false,
    processAlive: false,
    pid: null,
  };
}

export function createPuzzleCampaignSnapshot(state = 'LOADING') {
  return {
    generatedAt: null,
    campaigns: PUZZLE_CAMPAIGN_IDS.map((id) => emptyCampaign(id, safeState(state))),
  };
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
  if (!Number.isFinite(rate) || rate <= 0) return '0 steps/s';
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} G/s`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(2)} M/s`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(2)} K/s`;
  return `${rate.toFixed(0)} steps/s`;
}

function formatElapsed(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${rest}s` : `${minutes}m ${rest}s`;
}

function formatEta(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const years = seconds / 31_557_600;
  if (years >= 1e9) return `${(years / 1e9).toFixed(2)}B years`;
  if (years >= 1e6) return `${(years / 1e6).toFixed(2)}M years`;
  if (years >= 1e3) return `${(years / 1e3).toFixed(2)}K years`;
  if (years >= 1) return `${years.toFixed(1)} years`;
  return formatElapsed(seconds);
}

export function puzzleCampaignWorkRatio(campaign) {
  const done = Number(campaign.done);
  const total = Number(campaign.total);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

export function formatPuzzleCampaignPercent(ratio) {
  const percent = ratio * 100;
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 0.0001) return `${percent.toExponential(2)}%`;
  if (percent < 1) return `${percent.toFixed(6)}%`;
  return `${percent.toFixed(4)}%`;
}

function campaignCardMarkup(campaign) {
  const state = safeState(campaign.state);
  const active = state === 'RUNNING' && campaign.processAlive === true;
  const ratio = puzzleCampaignWorkRatio(campaign);
  const percent = formatPuzzleCampaignPercent(ratio);
  return `<article class="campaign-card" data-state="${state}">
    <div class="campaign-card-heading"><div><span>PUZZLE</span><h3>#${campaign.id}</h3></div><b class="campaign-state">${state}</b></div>
    <div class="campaign-bar-label"><span>Process activity</span><strong>${active ? 'Worker active' : state === 'NOT_STARTED' ? 'Not started' : 'No live worker'}</strong></div>
    <div class="campaign-activity-track" aria-hidden="true"><span></span></div>
    <div class="campaign-bar-label"><span>Expected-work progress</span><strong>${percent}</strong></div>
    <div class="campaign-work-track" role="progressbar" aria-label="Puzzle #${campaign.id} expected-work progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ratio * 100}" aria-valuetext="${percent}"><span style="width:${ratio * 100}%"></span></div>
    <dl class="campaign-card-stats"><div><dt>Steps done</dt><dd>${formatInteger(campaign.done)}</dd></div><div><dt>Current rate</dt><dd>${formatRate(campaign.ratePerSecond)}</dd></div><div><dt>Elapsed</dt><dd>${formatElapsed(campaign.elapsedSeconds)}</dd></div><div><dt>Median estimate</dt><dd>${formatEta(campaign.etaSeconds50)}</dd></div></dl>
    <div class="campaign-card-foot"><span>${campaign.pid ? `PID ${Number(campaign.pid)}` : escapeHtml(campaign.campaign || `p${campaign.id}`)}</span><span>${campaign.found ? 'KEY FOUND' : 'No key found'}</span></div>
  </article>`;
}

export function puzzleCampaignContentMarkup({ snapshot, error = '' }) {
  const source = snapshot || createPuzzleCampaignSnapshot('UNAVAILABLE');
  const campaigns = PUZZLE_CAMPAIGN_IDS.map((id) => source.campaigns?.find((campaign) => Number(campaign.id) === id) || emptyCampaign(id, 'UNAVAILABLE'));
  const running = campaigns.filter((campaign) => campaign.state === 'RUNNING' && campaign.processAlive === true).length;
  const found = campaigns.filter((campaign) => campaign.found === true).length;
  const combinedRate = campaigns.reduce((sum, campaign) => sum + (Number(campaign.ratePerSecond) || 0), 0);
  let combinedDone = 0n;
  for (const campaign of campaigns) {
    try { combinedDone += BigInt(campaign.done || 0); } catch { /* Ignore malformed worker data. */ }
  }
  const updated = source.generatedAt ? new Date(source.generatedAt).toLocaleTimeString() : 'waiting for data';
  return `<div class="campaign-summary-grid"><div><span>WORKERS LIVE</span><b>${running} / ${PUZZLE_CAMPAIGN_IDS.length}</b></div><div><span>COMBINED STEPS</span><b>${combinedDone.toLocaleString('en-US')}</b></div><div><span>COMBINED RATE</span><b>${formatRate(combinedRate)}</b></div><div><span>PRIVATE KEYS FOUND</span><b>${found}</b></div></div>
    ${error ? `<p class="campaign-api-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="campaign-grid">${campaigns.map(campaignCardMarkup).join('')}</div>
    <div class="campaign-monitor-foot"><span>Live workspace API · refreshes every second</span><span>Snapshot ${escapeHtml(updated)}</span></div>`;
}

export function puzzleCampaignStatusMarkup(view) {
  return `<section class="campaign-status-card exchange-card" id="campaign-status">
    <div class="exchange-panel-heading"><div><span class="eyebrow">REAL BOUNDED SEARCHES · WORKSPACE</span><h2>Puzzle campaign status</h2><p>Five pzsolve kangaroo campaigns with exact published ranges. Live worker status—not a toy demo.</p></div><span class="campaign-mode-pill">ACTUAL CAMPAIGNS</span></div>
    <div class="campaign-legend"><span><i class="activity-swatch"></i>Striped: process active</span><span><i class="work-swatch"></i>Blue: done / expected mean work</span></div>
    <div id="campaign-status-content">${puzzleCampaignContentMarkup(view)}</div>
    <p class="campaign-honesty-note">Activity is not likely recovery. The true progress fractions are extremely small and are not artificially enlarged. This panel never reads or displays private scalars.</p>
  </section>`;
}
