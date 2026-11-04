import { PROGRAMS, SCOPE_CHECKLIST, PROGRAM_VERIFICATION_MAX_AGE_MS } from './program-data.mjs';

export function officialProgramUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid official program URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'immunefi.com' || !/^\/bug-bounty\/[^/]+\/?$/.test(url.pathname)) throw new Error('Use an https://immunefi.com/bug-bounty/<program>/ URL.');
  url.hash = ''; url.search = '';
  return url.toString();
}

export function createCustomProgram({ name, url }) {
  const cleanName = String(name ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > 80) throw new Error('Program name must be 2–80 characters.');
  const canonical = officialProgramUrl(url);
  const slug = new URL(canonical).pathname.split('/').filter(Boolean).pop();
  return { id: `custom-${slug}`, name: cleanName, category: 'Custom', status: 'unverified', fit: 'Manual scope review required', url: canonical, scopeUrl: `${canonical.replace(/\/$/, '')}/scope/`, maxRewardUsd: null, webCriticalMaxUsd: null, pocRequired: null, kycRequired: null, primacy: 'Unknown', assets: [], keyGenerationNote: 'No scope or reward has been inferred. Read the official program.', restrictions: ['Custom entry is a bookmark, not authorization to test.'], researchAngle: 'Record the exact asset and impact after reading official terms.', sourceNote: 'User-added; never verified automatically.', custom: true };
}

export function createProgramState(programId, now = Date.now()) {
  return { programId, shortlisted: false, checked: {}, verifiedAt: null, notes: '', updatedAt: now };
}

export function verificationStatus(state, program, now = Date.now()) {
  if (!program || program.status === 'observed-paused') return { ready: false, reason: 'Program was paused in the snapshot; verify an active official program first.' };
  if (!state?.verifiedAt || now - state.verifiedAt > PROGRAM_VERIFICATION_MAX_AGE_MS || state.verifiedAt > now + 60000) return { ready: false, reason: 'Complete a fresh official scope review (valid for 24 hours in this workspace).' };
  const missing = SCOPE_CHECKLIST.filter((item) => !state.checked?.[item.id]);
  if (missing.length) return { ready: false, reason: `${missing.length} scope checklist item(s) remain.` };
  return { ready: true, reason: 'Local scope checklist completed within 24 hours. This is your attestation, not platform approval.' };
}

export function reportReadiness({ program, programState, entropy, source, fields, now = Date.now() }) {
  const reasons = [];
  const scope = verificationStatus(programState, program, now);
  if (!scope.ready) reasons.push(scope.reason);
  if (!entropy && !source) reasons.push('Attach an entropy audit or source review.');
  if (source && !entropy && !fields.manualValidation) reasons.push('Source matches are leads only: reproduce locally and confirm the data flow before reporting.');
  if (entropy?.verdict === 'no-anomaly-detected' && !source?.findings?.length && !fields.manualValidation) reasons.push('A clean statistical result is not a vulnerability. Add independently validated root-cause evidence.');
  for (const [key, label] of [['title', 'Report title'], ['asset', 'Exact affected asset/version'], ['impact', 'Demonstrated security impact'], ['reproduction', 'Reproduction steps'], ['remediation', 'Remediation']]) {
    if (!String(fields?.[key] ?? '').trim()) reasons.push(`${label} is required.`);
  }
  if (!fields?.ownData) reasons.push('Confirm that evidence uses your own data or explicit authorization.');
  if (!fields?.noExploit) reasons.push('Confirm no third-party funds or accounts were accessed or harmed.');
  if (!fields?.novel) reasons.push('Confirm this is not an already-public or known issue.');
  return { ready: reasons.length === 0, reasons, scope };
}

export function mergeProgramCatalog(customPrograms = []) {
  const ids = new Set(PROGRAMS.map((program) => program.id));
  const custom = customPrograms.filter((program) => program?.custom && !ids.has(program.id) && (ids.add(program.id), true));
  return [...PROGRAMS, ...custom];
}
