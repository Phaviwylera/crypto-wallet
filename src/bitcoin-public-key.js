import { base58, bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const hash160 = (bytes) => ripemd160(sha256(bytes));
const hex = bytesToHex;
const sameAddress = (a, b) => a.startsWith('bc1') && b.toLowerCase().startsWith('bc1') ? a.toLowerCase() === b.toLowerCase() : a === b;
function base58check(version, data) {
  const payload = Uint8Array.from([version, ...data]);
  return base58.encode(Uint8Array.from([...payload, ...sha256(sha256(payload)).slice(0, 4)]));
}
export function bitcoinAddressForKey(publicKey, type) {
  const key = typeof publicKey === 'string' ? hexToBytes(publicKey.replace(/^0x/, '')) : publicKey;
  secp256k1.Point.fromBytes(key); // Reject invalid points.
  if (type !== 'p2pkh' && key.length !== 33) throw new Error('SegWit requires a compressed key.');
  const keyHash = hash160(key);
  if (type === 'p2pkh') return base58check(0, keyHash);
  if (type === 'p2wpkh') return bech32.encode('bc', [0, ...bech32.toWords(keyHash)]);
  if (type === 'p2sh-p2wpkh') return base58check(5, hash160(Uint8Array.from([0, 20, ...keyHash])));
  throw new Error('Unsupported Bitcoin address type.');
}
export function matchesBitcoinAddress(address, point) {
  const uncompressed = point.toBytes(false), compressed = point.toBytes(true);
  return bitcoinAddressForKey(compressed, 'p2pkh') === address || bitcoinAddressForKey(uncompressed, 'p2pkh') === address || bitcoinAddressForKey(compressed, 'p2sh-p2wpkh') === address || bitcoinAddressForKey(compressed, 'p2wpkh') === address.toLowerCase();
}
function pushes(script) {
  if (typeof script !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(script)) return [];
  const bytes = hexToBytes(script), out = [];
  for (let i = 0; i < bytes.length;) {
    let n = bytes[i++];
    if (n === 0x4c) { if (i >= bytes.length) return []; n = bytes[i++]; }
    else if (n === 0x4d) { if (i + 2 > bytes.length) return []; n = bytes[i] | (bytes[i + 1] << 8); i += 2; }
    else if (n > 75) return [];
    if (i + n > bytes.length) return [];
    out.push(hex(bytes.slice(i, i + n))); i += n;
  }
  return out;
}
// Explorer transaction JSON supplies previous-output scripts and input stacks.
// This validates the key/address commitment, but does not independently prove inclusion in the blockchain.
export function findBitcoinPublicKey(address, transactions) {
  if (!Array.isArray(transactions)) throw new Error('Explorer returned invalid transaction history.');
  for (const tx of transactions) {
    if (!/^[0-9a-f]{64}$/i.test(tx?.txid ?? '') || !Array.isArray(tx.vin)) continue;
    for (const input of tx.vin) {
      const prev = input?.prevout;
      if (!prev || typeof prev.scriptpubkey !== 'string' || !sameAddress(address, prev.scriptpubkey_address ?? '')) continue;
      const script = prev.scriptpubkey.toLowerCase();
      const scriptItems = pushes(input.scriptsig ?? '');
      const witness = Array.isArray(input.witness) ? input.witness : [];
      let candidates = [];
      if (/^76a914[0-9a-f]{40}88ac$/.test(script) && scriptItems.length === 2) candidates = [{ key: scriptItems[1], type: 'p2pkh' }];
      if (/^0014[0-9a-f]{40}$/.test(script) && witness.length === 2) candidates = [{ key: witness[1], type: 'p2wpkh' }];
      if (/^a914[0-9a-f]{40}87$/.test(script) && scriptItems.length === 1 && witness.length === 2) candidates = [{ key: witness[1], type: 'p2sh-p2wpkh', redeem: scriptItems[0] }];
      for (const candidate of candidates) {
        try {
          if (!/^(02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/i.test(candidate.key)) continue;
          const key = hexToBytes(candidate.key);
          if (candidate.redeem && candidate.redeem.toLowerCase() !== `0014${hex(hash160(key))}`) continue;
          const expectedScript = candidate.type === 'p2pkh' ? `76a914${hex(hash160(key))}88ac` : candidate.type === 'p2wpkh' ? `0014${hex(hash160(key))}` : `a914${hex(hash160(hexToBytes(candidate.redeem)))}87`;
          if (expectedScript !== script || !sameAddress(bitcoinAddressForKey(key, candidate.type), address)) continue;
          const point = secp256k1.Point.fromBytes(key);
          return { address, txHash: `0x${tx.txid}`, publicKey: `0x${hex(point.toBytes(false))}`, type: candidate.type };
        } catch { /* Ignore invalid stack data. */ }
      }
    }
  }
  return null;
}
export async function lookupBitcoinPublicKey(address, { fetchImpl = fetch, maxPages = 5 } = {}) {
  if (typeof address !== 'string' || address.length > 90 || !/^[a-zA-Z0-9]+$/.test(address)) throw new Error('Enter a valid Bitcoin mainnet address.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('Invalid history page limit.');
  let cursor = '', pages = 0;
  while (pages < maxPages) {
    const url = `https://mempool.space/api/address/${encodeURIComponent(address)}/txs${cursor ? `/chain/${cursor}` : ''}`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Bitcoin explorer returned HTTP ${response.status}.`);
    const transactions = await response.json(); pages++;
    const result = findBitcoinPublicKey(address, transactions);
    if (result) return { ...result, pages };
    const confirmed = transactions.filter(tx => tx.status?.confirmed && /^[0-9a-f]{64}$/i.test(tx.txid ?? ''));
    if (confirmed.length < 25) return { status: 'not_found', pages, historyComplete: true };
    const next = confirmed.at(-1).txid;
    if (next === cursor) throw new Error('Explorer returned a repeated history page.');
    cursor = next;
  }
  return { status: 'not_found', pages, historyComplete: false };
}
