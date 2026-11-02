// Run independent public-key recovery requests while preserving input order.
// Cancellation is cooperative: in-flight recoveries finish, no new rows start.
export async function runRecoveryBatch({ entries, recover, concurrency = 4, shouldStop = () => false, onProgress = () => {} }) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('A recovery batch needs at least one row.');
  if (typeof recover !== 'function') throw new Error('A recovery function is required.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid recovery batch concurrency.');

  const results = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;
  let succeeded = 0;
  const processNext = async () => {
    while (nextIndex < entries.length && !shouldStop()) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      try {
        const recovered = await recover(entry, index);
        if (!/^0x04[0-9a-f]{128}$/i.test(recovered?.publicKey ?? '')) throw new Error('Recovery did not return a valid uncompressed public key.');
        results[index] = {
          address: entry.address,
          txHash: recovered.txHash || entry.txHash || '',
          publicKey: recovered.publicKey,
          status: 'ok',
          type: recovered.type || '',
        };
        succeeded += 1;
      } catch (error) {
        results[index] = { ...entry, publicKey: '', status: error?.message ?? String(error) };
      }
      completed += 1;
      onProgress({ completed, succeeded, total: entries.length, stopping: shouldStop() });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, processNext));
  for (let index = 0; index < results.length; index += 1) {
    if (!results[index]) results[index] = { ...entries[index], publicKey: '', status: 'cancelled before processing' };
  }
  return results;
}
