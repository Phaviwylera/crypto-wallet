const SOURCE_PRIORITY = { puzzle: 1, search: 2, recovery: 3, scan: 4, session: 5 };

/** Collect only public addresses already represented in the Seedlab workspace. */
export function collectWalletSpacePoints({
  wallet,
  selectedNetworkId,
  networks,
  scanState,
  searchAddressFile,
  labAddressInput,
  keyRecovery,
  puzzles,
  parseAddress,
}) {
  const points = new Map();

  function add(address, networkId, source) {
    const network = networks[networkId];
    if (!network || !address) return;
    try {
      const parsed = parseAddress(String(address).trim(), networkId);
      if (!parsed?.valid || !(parsed.bytes instanceof Uint8Array)) return;
      const display = parsed.display;
      const key = `${network.family}:${display.toLowerCase()}`;
      const existing = points.get(key);
      if (existing) {
        existing.networkLabels.add(network.label);
        existing.sourceLabels.add(source);
        if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[existing.source]) existing.source = source;
        return;
      }
      points.set(key, {
        id: key,
        address: display,
        networkId,
        networkLabel: network.label,
        networkLabels: new Set([network.label]),
        source,
        sourceLabels: new Set([source]),
        payload: Uint8Array.from(parsed.bytes),
      });
    } catch {
      // An incomplete edit or unsupported historical row is not a map point.
    }
  }

  function addBitcoin(address, source) {
    for (const networkId of ['bitcoin', 'bitcoinLegacy', 'bitcoinNested']) {
      const before = points.size;
      add(address, networkId, source);
      if (points.size > before) return;
    }
  }

  if (wallet?.stage >= 5 && wallet.address) add(wallet.address, selectedNetworkId, 'session');
  if (labAddressInput?.trim()) add(labAddressInput, selectedNetworkId, 'search');
  for (const address of searchAddressFile?.addresses ?? []) add(address, selectedNetworkId, 'search');

  for (const result of scanState?.results ?? []) {
    if (!result?.valid) continue;
    for (const [networkId, address] of Object.entries(result.addresses ?? {})) add(address, networkId, 'scan');
  }

  if (keyRecovery?.result?.address) {
    if (keyRecovery.network === 'bitcoin') addBitcoin(keyRecovery.result.address, 'recovery');
    else add(keyRecovery.result.address, 'ethereum', 'recovery');
  }
  for (const row of keyRecovery?.batchResults ?? []) {
    if (keyRecovery.network === 'bitcoin') addBitcoin(row.address, 'recovery');
    else add(row.address, 'ethereum', 'recovery');
  }

  for (const puzzle of puzzles ?? []) add(puzzle.address, 'bitcoinLegacy', 'puzzle');

  return [...points.values()].map((point) => ({
    ...point,
    networkLabel: [...point.networkLabels].join(' / '),
    sourceLabels: [...point.sourceLabels],
  }));
}
