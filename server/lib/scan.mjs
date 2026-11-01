// Scan engine: takes parsed input lines, derives addresses for each, and reports
// progress through the job store. Designed to run in-process (local) or inside a
// Lambda invocation kicked off by an S3 upload event.
import { classifyInput, deriveSecret, NETWORK_IDS } from './networks.mjs';
import { getWalletBalances, getPrices } from './balances.mjs';

export const NETWORK_LABELS = NETWORK_IDS.reduce((acc, id) => acc, {});

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// lines: array of raw strings
// store: job store with createJob/updateJob/appendResults
// opts.onProgress optional callback(jobSnapshot)
export async function runScan(jobId, lines, store, opts = {}) {
  const total = lines.length;
  let job = await store.createJob(jobId, total);
  const prices = await getPrices();
  const batch = [];
  const flushBatch = async () => {
    if (!batch.length) return;
    const chunk = batch.splice(0, batch.length);
    job = await store.appendResults(jobId, chunk);
    if (opts.onProgress) opts.onProgress(job);
  };

  try {
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const input = classifyInput(raw);
      let result;
      if (input.kind === 'blank') {
        continue; // skip silently but still advance progress
      } else {
        try {
          result = deriveSecret(input);
        } catch (err) {
          result = { kind: input.kind, value: input.value, valid: false, reason: `Derivation error: ${err.message}` };
        }
      }
      let balances = null;
      let totalValueUsd = 0;
      let mocked = false;
      if (result.valid && result.addresses) {
        try {
          const walletBalances = await getWalletBalances(result.addresses, prices);
          balances = walletBalances.balances;
          totalValueUsd = walletBalances.totalValueUsd;
          mocked = walletBalances.mocked;
        } catch {
          balances = null;
        }
      }
      batch.push({
        index,
        input: input.value,
        kind: result.kind,
        valid: result.valid,
        reason: result.reason || null,
        addresses: result.addresses || null,
        publicKeys: result.publicKeys || null,
        balances,
        totalValueUsd,
        mocked,
      });
      // Flush periodically so the UI shows live progress even on large files.
      if (batch.length >= 25) await flushBatch();
      // Yield to the event loop so status polls are not starved.
      if (index % 50 === 49) await sleep(0);
    }
    await flushBatch();
    job = await store.updateJob(jobId, { status: 'done' });
    if (opts.onProgress) opts.onProgress(job);
    return job;
  } catch (err) {
    await store.updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  }
}
