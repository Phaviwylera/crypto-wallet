/**
 * Editorial snapshot, not a live Immunefi API. Every record links to official terms.
 * Reward ceilings are not promises; exact asset, impact and program rules control.
 */
export const PROGRAM_SNAPSHOT_DATE = '2026-11-04';
export const IMMUNEFI_RULES_URL = 'https://immunefi.com/rules/';
export const IMMUNEFI_EXPLORE_URL = 'https://immunefi.com/bug-bounty/';
export const IMMUNEFI_SUBMIT_URL = 'https://bugs.immunefi.com/dashboard/new-submission';
export const PROGRAM_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const PROGRAMS = [
  {
    id: '1inch-wallet', name: '1inch — Wallet', category: 'Wallet', status: 'observed-active', fit: 'Direct wallet scope',
    url: 'https://immunefi.com/bug-bounty/1inch-wallet/information/', scopeUrl: 'https://immunefi.com/bug-bounty/1inch-wallet/scope/',
    maxRewardUsd: 100000, webCriticalMaxUsd: 100000, pocRequired: true, kycRequired: true, primacy: 'Rules',
    assets: ['Official Android wallet listed in program scope', 'Official iOS wallet listed in program scope'],
    keyGenerationNote: 'The official reward terms explicitly include private key or private key generation leakage leading to unauthorized access to user funds. This does not establish that any such bug exists.',
    restrictions: ['Primacy of Rules: exact listed assets and impacts control.', 'Latest official production app-store builds; modified, side-loaded, beta, staging and self-built versions have a non-production cap.', 'Report within 24 hours of initial discovery; later eligibility is discretionary.', 'Theoretical impacts without proof and best-practice-only recommendations are excluded.'],
    researchAngle: 'Review authorized wallet key-generation/storage paths, platform RNG fallbacks and release-build behavior. Use only your own test account and local evidence.',
    sourceNote: 'Official information and scope pages retrieved 2026-11-04; page last updated 2026-10-09. Recheck before testing.',
  },
  {
    id: '0x', name: '0x', category: 'Web / app', status: 'observed-active', fit: 'Conditional key-generation impact',
    url: 'https://immunefi.com/bug-bounty/0x/information/', scopeUrl: 'https://immunefi.com/bug-bounty/0x/scope/',
    maxRewardUsd: 1000000, webCriticalMaxUsd: 50000, pocRequired: true, kycRequired: true, primacy: 'Mixed',
    assets: ['Exact web/app assets listed in the official scope'],
    keyGenerationNote: 'Critical web/app reward terms include private key or private key generation leakage. The headline $1M ceiling is for smart contracts, not this web/app impact.',
    restrictions: ['Primacy of Impact is listed for smart-contract Critical, not blanket web/app coverage.', 'Known issues and program-specific exclusions apply.', 'A generic PRNG observation without an affected in-scope asset and demonstrated impact is not a submission-ready report.'],
    researchAngle: 'Trace any secret-generation or wallet-interaction path in an explicitly in-scope asset. Do not assume a DEX aggregator generates user wallet keys.',
    sourceNote: 'Official information page retrieved 2026-11-04; page last updated 2026-09-21. Recheck scope and known issues.',
  },
  {
    id: 'ens', name: 'ENS', category: 'Web / app', status: 'observed-active', fit: 'Conditional key-generation impact',
    url: 'https://immunefi.com/bug-bounty/ens/information/', scopeUrl: 'https://immunefi.com/bug-bounty/ens/scope/',
    maxRewardUsd: 250000, webCriticalMaxUsd: 25000, pocRequired: true, kycRequired: true, primacy: 'Mixed',
    assets: ['Exact ENS web/app assets listed in the official scope'],
    keyGenerationNote: 'The critical web/app reward calculation includes private key or private key generation leakage. The $250,000 program ceiling is a smart-contract ceiling.',
    restrictions: ['Custom reward calculation and program terms control.', 'Confirm the exact affected asset and impact; do not infer wallet key generation from the ENS name.', 'Previously disclosed issues are not new bounty findings.'],
    researchAngle: 'Audit only authorized ENS application paths that actually handle secret material or wallet interactions.',
    sourceNote: 'Official information page retrieved 2026-11-04; page last updated 2026-10-30. Recheck before testing.',
  },
  {
    id: 'avalabs', name: 'Ava Labs', category: 'Wallet / web', status: 'observed-paused', fit: 'Paused — do not test',
    url: 'https://immunefi.com/bug-bounty/avalabs/information/', scopeUrl: 'https://immunefi.com/bug-bounty/avalabs/scope/',
    maxRewardUsd: 10000, webCriticalMaxUsd: 10000, pocRequired: true, kycRequired: true, primacy: 'Rules',
    assets: ['Historical snapshot only; verify current status before any testing'],
    keyGenerationNote: 'Historical terms mention private key generation leakage, but the official page displayed Paused when retrieved.',
    restrictions: ['Paused at snapshot: this workspace does not authorize testing or submission.', 'A paused program must not be treated as an active bounty.'],
    researchAngle: 'Use as a scope-tracking example only until the official program is active again.',
    sourceNote: 'Official page retrieved 2026-11-04 displayed Paused; page last updated 2026-10-07.',
  },
  {
    id: 'zerion', name: 'Zerion', category: 'Wallet / web', status: 'observed-paused', fit: 'Paused — do not test',
    url: 'https://immunefi.com/bug-bounty/zerion/information/', scopeUrl: 'https://immunefi.com/bug-bounty/zerion/scope/',
    maxRewardUsd: 25000, webCriticalMaxUsd: 15000, pocRequired: true, kycRequired: true, primacy: 'Rules',
    assets: ['Historical snapshot only; verify current status before any testing'],
    keyGenerationNote: 'The program overview says users connect their own wallets and Zerion does not control their private keys. Do not assume a key-generation attack surface.',
    restrictions: ['Paused at snapshot: this workspace does not authorize testing or submission.', 'Historical terms restrict testing to local forks and exclude significant automated traffic.'],
    researchAngle: 'Use as a reminder to distinguish a wallet interface from a wallet key generator.',
    sourceNote: 'Official page retrieved 2026-11-04 displayed Paused; page last updated 2026-09-21.',
  },
];

export const SCOPE_CHECKLIST = [
  { id: 'active', label: 'Official program is active and accepts submissions' },
  { id: 'asset', label: 'Exact affected asset, version and repository/build are in scope' },
  { id: 'impact', label: 'Demonstrated impact is listed in the program’s impacts in scope' },
  { id: 'rules', label: 'Rules, exclusions, known issues and primacy have been reviewed' },
  { id: 'authorization', label: 'Testing uses my own data or explicit written authorization' },
  { id: 'poc', label: 'PoC requirements, reporting deadline, KYC and publication terms are understood' },
];

export const RESEARCH_REFERENCES = [
  { title: 'Immunefi platform rules', url: IMMUNEFI_RULES_URL, note: 'Prohibits exploitation, unauthorized rescue, already-public bug reports, high-traffic automated testing, and scanner-only reports without demonstrated impact.' },
  { title: 'Milk Sad / CVE-2023-39910', url: 'https://milksad.info/', note: 'Historical weak-entropy research: a time-seeded MT19937 reduced Libbitcoin Explorer 3.x seed entropy to 32 bits. Already public; not a new bounty.' },
  { title: 'Trust Wallet / CVE-2023-31290', url: 'https://nvd.nist.gov/vuln/detail/CVE-2023-31290', note: 'Historical browser-extension entropy flaw. Public and patched; this workspace does not enumerate affected keys or locate third-party funds.' },
];
