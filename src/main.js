import { HDKey } from '@scure/bip32';
import { base58, bech32, bech32m } from '@scure/base';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { recoverEthereumTransactionPublicKey } from './ethereum-transaction.js';
import { parseSearchRange, partitionSearchRange } from './search-range.js';
import { captureScalarFocus, restoreScalarFocus } from './input-focus.js';
import { createPublicKeySearchPool } from './public-key-search-pool.js';
import { createGpuBridgeHost } from './webgpu-bridge.js';
import { planRange, rangeForBitLength } from './range-planner.js';
import './style.css';

const app = document.querySelector('#app');
const NETWORKS = {
  ethereum: { label: 'Ethereum', shortLabel: 'ETH', family: 'evm', path: "m/44'/60'/0'/0/0", pathLabels: ['BIP-44 purpose', 'Ethereum coin type', 'account', 'external chain', 'address index'] },
  bitcoin: { label: 'Bitcoin · Native SegWit', shortLabel: 'BTC P2WPKH', family: 'bitcoin', format: 'p2wpkh', path: "m/84'/0'/0'/0/0", pathLabels: ['BIP-84 purpose', 'Bitcoin coin type', 'account', 'receive chain', 'address index'] },
  bitcoinLegacy: { label: 'Bitcoin · Legacy', shortLabel: 'BTC Legacy', family: 'bitcoin', format: 'p2pkh', path: "m/44'/0'/0'/0/0", pathLabels: ['BIP-44 purpose', 'Bitcoin coin type', 'account', 'external chain', 'address index'] },
  bitcoinNested: { label: 'Bitcoin · Nested SegWit', shortLabel: 'BTC Nested', family: 'bitcoin', format: 'p2sh-p2wpkh', path: "m/49'/0'/0'/0/0", pathLabels: ['BIP-49 purpose', 'Bitcoin coin type', 'account', 'change chain', 'address index'] },
  bitcoinTaproot: { label: 'Bitcoin · Taproot', shortLabel: 'BTC Taproot', family: 'bitcoin', format: 'p2tr', path: "m/86'/0'/0'/0/0", pathLabels: ['BIP-86 purpose', 'Bitcoin coin type', 'account', 'change chain', 'address index'] },
  tron: { label: 'TRON', shortLabel: 'TRX', family: 'tron', path: "m/44'/195'/0'/0/0", pathLabels: ['BIP-44 purpose', 'TRON coin type', 'account', 'external chain', 'address index'] },
  bnb: { label: 'BNB Smart Chain', shortLabel: 'BNB Smart Chain', family: 'evm', path: "m/44'/60'/0'/0/0", pathLabels: ['BIP-44 purpose', 'EVM coin type', 'account', 'external chain', 'address index'] },
  bnbBeacon: { label: 'BNB Beacon Chain · Legacy', shortLabel: 'BNB Beacon', family: 'bnbBeacon', path: "m/44'/714'/0'/0/0", pathLabels: ['BIP-44 purpose', 'BNB coin type', 'account', 'external chain', 'address index'] },
};
let selectedNetworkId = 'ethereum';
const SEARCH_WORKER_CHUNK = 256;
let searchLower = '1';
let searchUpper = '10000';
const selectedNetwork = () => NETWORKS[selectedNetworkId];
let wallet = freshWallet();
let passphrase = '';
let copied = new Set();
let backwardOpen = false;
let discreteLogResult = null;
let discreteLogProgress = null;
let searchRunId = 0;
let activeSearch = null;
let searchRenderTimer = null;
let labAddressInput = null;
let searchAddressFile = null;
let ethereumRpcEndpoint = 'https://ethereum-rpc.publicnode.com';
let rangePlanner = { bits: '', targets: '1', rate: '', error: '' };
let pointSearch = { fileName: '', text: '', lower: '1', upper: '1000000', workers: 'auto', backend: 'cpu', busy: false, count: 0, progress: null, result: null, error: '' };
let pointSearchPool = null;
let gpuBenchmark = { preference: 'high-performance', busy: false, progress: null, result: null, error: '' };
let gpuBenchmarkWorker = null;
let kangarooDemoResult = null;
let kangarooDemoBusy = false;
let kangarooDemoError = '';
let pendingFile = null;
let scanState = { jobId: null, status: 'idle', total: 0, processed: 0, results: [], error: null, hideEmpty: true };
const API_BASE = (import.meta.env && import.meta.env.VITE_SCAN_API_BASE) || '';

function freshWallet() {
  return {
    stage: 0,
    entropy: null,
    entropyHash: null,
    entropyChecksum: '',
    wordChunks: [],
    phrase: '',
    bip39Salt: null,
    seed: null,
    master: null,
    masterHmacOutput: null,
    pathNodes: [],
    account: null,
    publicKey: null,
    keccakHash: null,
    addressBytes: null,
    eip55Hash: null,
    tronPayload: null,
    tronShaFirst: null,
    tronShaSecond: null,
    tronChecksum: null,
    tronBase58Bytes: null,
    btcHash160: null,
    btcSha256: null,
    btcRedeemScript: null,
    btcScriptHash: null,
    btcPayload: null,
    btcChecksum: null,
    taprootData: null,
    compressedPublicKey: null,
    address: '',
  };
}

function hex(bytes) {
  return bytes ? bytesToHex(bytes) : '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function spacedHex(bytes) {
  return hex(bytes).match(/.{1,8}/g)?.join(' ') ?? '';
}

function shortHex(bytes, head = 14, tail = 10) {
  const value = hex(bytes);
  return value.length > head + tail ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds < 31_557_600) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
  return `${(seconds / 31_557_600).toLocaleString(undefined, { maximumFractionDigits: 1 })} years`;
}

function byteGrid(bytes, addressStart = -1) {
  return Array.from(bytes, (value, index) => `<span class="hash-byte ${index >= addressStart ? 'address-byte' : ''}"><small>${index.toString(16).padStart(2, '0')}</small><b>${value.toString(16).padStart(2, '0')}</b></span>`).join('');
}

function looksLikeEvmPublicKey(input) {
  const key = input.trim().replace(/\s+/g, '').replace(/^0x/i, '');
  return /^(?:[0-9a-fA-F]{128}|04[0-9a-fA-F]{128}|0[23][0-9a-fA-F]{64})$/.test(key);
}

function addressPlaceholder() {
  const network = selectedNetwork();
  if (selectedNetworkId === 'bitcoinTaproot') return 'bc1p…';
  if (network.family === 'bitcoin') return network.format === 'p2wpkh' ? 'bc1q…' : network.format === 'p2sh-p2wpkh' ? '3…' : '1…';
  if (network.family === 'bnbBeacon') return 'bnb1…';
  return network.family === 'tron' ? 'T…' : '0x…';
}

function addressCaption(network = selectedNetwork()) {
  if (network.family === 'bitcoin') {
    return ({ p2wpkh: 'BIP-84 · HASH160 · Bech32', p2pkh: 'BIP-44 · HASH160 · Base58Check', 'p2sh-p2wpkh': 'BIP-49 · nested SegWit · Base58Check', p2tr: 'BIP-86 · TapTweak · Bech32m' })[network.format];
  }
  if (network.family === 'bnbBeacon') return 'BIP-44 · HASH160 · Bech32';
  if (network.family === 'tron') return 'Keccak-256 · Base58Check';
  return 'Keccak-256 · last 20 bytes · EIP-55';
}

function addressInputHint() {
  const network = selectedNetwork();
  if (network.family === 'bitcoin') {
    if (network.format === 'p2wpkh') return 'Bitcoin mainnet P2WPKH native SegWit (bc1q…), Bech32 v0.';
    if (network.format === 'p2tr') return 'Bitcoin mainnet P2TR Taproot (bc1p…), BIP-86 and Bech32m v1.';
    if (network.format === 'p2sh-p2wpkh') return 'Bitcoin mainnet P2SH-wrapped P2WPKH (3…), BIP-49 Base58Check.';
    return 'Bitcoin mainnet P2PKH legacy address (1…), BIP-44 Base58Check.';
  }
  if (network.family === 'bnbBeacon') return 'BNB Beacon Chain Bech32 address with bnb human-readable prefix.';
  if (network.family === 'tron') return 'TRON mainnet Base58Check address (usually starts with T).';
  return 'Paste a 20-byte 0x address, or a 33/64/65-byte secp256k1 public key to calculate its full Keccak-256 digest. Mixed-case addresses must pass EIP-55.';
}

function networkAddressDetails(parsed, network) {
  if (network.family === 'bitcoin') {
    if (network.format === 'p2wpkh') {
      const scriptPubKey = new Uint8Array([0x00, 0x14, ...parsed.bytes]);
      return `<p>Witness version: <b>0</b> · HRP: <b>bc</b> · Bech32 v0</p><p>HASH160 witness program: <code>${hex(parsed.bytes)}</code></p><p>P2WPKH scriptPubKey: <code>${hex(scriptPubKey)}</code></p>`;
    }
    if (network.format === 'p2tr') return `<p>Witness version: <b>1</b> · HRP: <b>bc</b> · Bech32m</p><p>Taproot output-key program: <code>${hex(parsed.bytes)}</code></p>`;
    return network.format === 'p2pkh'
      ? `<p>P2PKH payload (version 00 || HASH160): <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p>`
      : `<p>P2SH script hash: <code>${hex(parsed.bytes)}</code></p><p>P2SH payload (version 05 || script hash): <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p><p>The address alone does not reveal the redeem script; a candidate's script is derived from its public key.</p>`;
  }
  if (network.family === 'bnbBeacon') return `<p>HASH160(compressed public key): <code>${hex(parsed.bytes)}</code></p><p>Bech32 HRP: <b>bnb</b> · checksum verified</p>`;
  if (network.family === 'tron') return `<p>Version + address payload: <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p>`;
  if (parsed.inputKind === 'publicKey') return `<p>EIP-55 checksum hash of lowercase address text:</p><div class="hash-byte-grid output-byte-grid">${byteGrid(parsed.checksumHash, parsed.checksumHash.length)}</div>`;
  return `<p>EIP-55 checksum hash: Keccak-256 of the lowercase address text (40 hex characters) · full 32-byte digest:</p><div class="hash-byte-grid output-byte-grid">${byteGrid(parsed.checksumHash, parsed.checksumHash.length)}</div><p>This EIP-55 digest is for address-letter casing. It is not the Keccak digest of the public key used to create the address; that original digest cannot be recovered from the 20-byte address alone.</p>`;
}

function binary(bytes) {
  return Array.from(bytes, (value) => value.toString(2).padStart(8, '0')).join('');
}

function checksumAddress(lowerHex, checksumDigest) {
  const lower = lowerHex.toLowerCase();
  const hash = hex(checksumDigest ?? keccak_256(new TextEncoder().encode(lower)));
  const checksummed = Array.from(lower, (character, index) => {
    if (/[a-f]/.test(character) && parseInt(hash[index], 16) >= 8) return character.toUpperCase();
    return character;
  }).join('');
  return `0x${checksummed}`;
}

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((all, part) => all + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${hex(bytes)}`);
}

function bigIntToBytes(value) {
  const bytes = new Uint8Array(32);
  let number = value;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  return bytes;
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function base58Check(versionedPayload) {
  const checksum = sha256(sha256(versionedPayload)).slice(0, 4);
  const bytes = concatBytes(versionedPayload, checksum);
  return { address: base58.encode(bytes), payload: versionedPayload, checksum, bytes };
}

function taggedHash(tag, message) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, message));
}

function taprootDetails(privateKey) {
  const scalar = bytesToBigInt(privateKey);
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const yIsOdd = (publicKey[64] & 1) === 1;
  const evenScalar = yIsOdd ? SECP256K1_ORDER - scalar : scalar;
  const internalPrivateKey = bigIntToBytes(evenScalar);
  const internalPublicKey = secp256k1.getPublicKey(internalPrivateKey, true);
  const internalX = internalPublicKey.slice(1);
  const tweakHash = taggedHash('TapTweak', internalX);
  const tweak = bytesToBigInt(tweakHash);
  if (tweak >= SECP256K1_ORDER) throw new Error('Invalid BIP-341 TapTweak scalar');
  const outputScalar = (evenScalar + tweak) % SECP256K1_ORDER;
  if (outputScalar === 0n) throw new Error('Invalid BIP-341 tweaked private scalar');
  const outputPrivateKey = bigIntToBytes(outputScalar);
  const outputPublicKey = secp256k1.getPublicKey(outputPrivateKey, true);
  const outputX = outputPublicKey.slice(1);
  return {
    internalX,
    internalPrivateKey,
    tweakHash,
    tweak: bigIntToBytes(tweak),
    outputPrivateKey,
    outputPublicKey,
    outputX,
    address: bech32m.encode('bc', [1, ...bech32m.toWords(outputX)]),
  };
}

function exportTextFile(filename, contents) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Try the user-gesture fallback; this may vary by browser on plain HTTP.
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const success = document.execCommand('copy');
  field.remove();
  if (!success) throw new Error('Clipboard access was blocked');
}

function copyValue(key) {
  const values = {
    entropy: () => hex(wallet.entropy),
    entropyHash: () => hex(wallet.entropyHash),
    phrase: () => wallet.phrase,
    salt: () => hex(wallet.bip39Salt),
    seed: () => hex(wallet.seed),
    masterHmac: () => hex(wallet.masterHmacOutput),
    masterPrivate: () => hex(wallet.master?.privateKey),
    chainCode: () => hex(wallet.master?.chainCode),
    accountPrivate: () => hex(wallet.account?.privateKey),
    publicKey: () => hex(wallet.publicKey),
    compressedPublicKey: () => hex(wallet.compressedPublicKey),
    publicBody: () => hex(wallet.publicKey?.slice(1)),
    tronPayload: () => hex(wallet.tronPayload),
    tronShaFirst: () => hex(wallet.tronShaFirst),
    tronShaSecond: () => hex(wallet.tronShaSecond),
    tronChecksum: () => hex(wallet.tronChecksum),
    tronBase58Bytes: () => hex(wallet.tronBase58Bytes),
    btcHash160: () => hex(wallet.btcHash160),
    btcSha256: () => hex(wallet.btcSha256),
    btcPayload: () => hex(wallet.btcPayload),
    btcChecksum: () => hex(wallet.btcChecksum),
    btcRedeemScript: () => hex(wallet.btcRedeemScript),
    btcScriptHash: () => hex(wallet.btcScriptHash),
    taprootInternalX: () => hex(wallet.taprootData?.internalX),
    taprootTweakHash: () => hex(wallet.taprootData?.tweakHash),
    taprootTweak: () => hex(wallet.taprootData?.tweak),
    taprootOutputX: () => hex(wallet.taprootData?.outputX),
    taprootOutputPrivateKey: () => hex(wallet.taprootData?.outputPrivateKey),
    keccak: () => hex(wallet.keccakHash),
    addressBytes: () => hex(wallet.addressBytes),
    eip55Hash: () => hex(wallet.eip55Hash),
    searchPublicKey: () => hex(discreteLogResult?.parsed?.publicKey),
    searchKeyDigest: () => hex(discreteLogResult?.parsed?.keyKeccakHash),
    address: () => wallet.address,
  };
  return values[key]?.() ?? '';
}

function copyButton(key, title = 'Copy') {
  return `<button class="copy-button" type="button" data-copy="${key}">${copied.has(key) ? 'Copied' : title}</button>`;
}

function stageBadge(step) {
  if (wallet.stage >= step) return '<span class="step-status complete">DONE</span>';
  if (wallet.stage + 1 === step) return '<span class="step-status ready">NEXT</span>';
  return '<span class="step-status">LOCKED</span>';
}

function stepCard({ number, title, caption, step, body, action }) {
  const unlocked = wallet.stage >= step - 1;
  return `<section class="step-card ${wallet.stage >= step ? 'is-complete' : ''} ${unlocked ? '' : 'is-locked'}">
    <div class="step-heading"><span class="step-number">${number}</span><div class="step-heading-copy"><h2>${title}</h2><p>${caption}</p></div>${stageBadge(step)}</div>
    ${unlocked ? body : '<p class="locked-note">Complete the previous step to reveal this calculation.</p>'}
    ${action && wallet.stage === step - 1 ? `<div class="step-action"><button class="action-button" data-run-step="${step}">${action}<span aria-hidden="true">↗</span></button></div>` : ''}
  </section>`;
}


function searchResultMarkup(result, network) {
  if (!result) return '<p class="dlog-placeholder">Enter an address or public key and search a bounded test range.</p>';
  if (result.status === 'invalid') return `<div class="dlog-warning result-error"><strong>Invalid ${network.label} input.</strong> ${escapeHtml(result.reason)}</div>`;
  if (result.status === 'publicKey') return `<div class="dlog-results"><div><label>INPUT · VALIDATED SECP256K1 PUBLIC KEY</label><code class="dlog-address-value">${hex(result.parsed.publicKey)}</code>${copyButton('searchPublicKey', 'Copy public key')}<p>Point validation succeeded. No private key was derived.</p></div><div><label>FULL ADDRESS-GENERATION DIGEST · 32 BYTES</label><p>Keccak-256(public key body X || Y):</p><div class="hash-byte-grid output-byte-grid">${byteGrid(result.parsed.keyKeccakHash, result.parsed.keyKeccakHash.length)}</div>${copyButton('searchKeyDigest', 'Copy 32-byte digest')}</div><div><label>DERIVED ETHEREUM ADDRESS</label><code class="dlog-address-value">${result.parsed.display}</code>${networkAddressDetails(result.parsed, network)}<p>No scalar search was run.</p></div></div>`;
  if (result.status === 'cancelled') return `<div class="dlog-warning"><strong>Search stopped.</strong> Checked ${result.totalTested.toLocaleString()} of ${result.rangeCount.toLocaleString()} candidates in ${result.elapsedMs.toFixed(1)} ms (${result.candidatesPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} candidates/second). This partial run cannot rule out the untested scalars.</div>`;
  if (result.status === 'error') return `<div class="dlog-warning result-error"><strong>Search failed.</strong> ${escapeHtml(result.message)}</div>`;
  const targets = result.targets?.length ? result.targets : [result.parsed];
  const matchText = result.foundScalar
    ? `Match found at scalar d=${result.foundScalar}; it matches target ${result.matchTargetIndex + 1} of ${targets.length}.`
    : `No match for any of the ${targets.length} target${targets.length === 1 ? '' : 's'} in the complete interval ${result.startScalar.toLocaleString()}–${result.endScalar.toLocaleString()}.`;
  const targetList = targets.map((target, index) => `<li><b>${index + 1}.</b> <code>${escapeHtml(target.display)}</code>${result.foundScalar && index === result.matchTargetIndex ? ' <strong>← MATCH</strong>' : ''}</li>`).join('');
  return `<div class="dlog-results"><div><label>INPUT · ${targets.length} ${targets.length === 1 ? 'ADDRESS TARGET' : 'ADDRESS TARGETS'}</label><ul class="search-target-list">${targetList}</ul>${targets.length === 1 ? `<div class="hash-byte-grid address-byte-grid">${byteGrid(targets[0].bytes)}</div>${networkAddressDetails(targets[0], network)}` : '<p>Every candidate was checked against all loaded addresses in the same pass.</p>'}</div><div><label>RESULT · ${result.foundScalar ? 'MATCH' : 'FULL RANGE TESTED'}</label><p>${matchText}</p><p>${result.totalTested.toLocaleString()} candidates checked · ${result.elapsedMs.toFixed(1)} ms · ${result.candidatesPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} candidates/second across ${result.workers} workers.</p><p>${result.foundScalar ? `Matching public key: <code class="dlog-address-value">${result.foundPublicKey}</code>` : 'This excludes only the tested scalar interval; it does not recover or rule out keys outside it.'}</p><p>This bounded test is not a practical real-wallet recovery method.</p></div></div>`;
}

function scanCardMarkup() {
  return `
    <section class="scan-card" id="scan-card">
      <div class="scan-heading"><div><span class="eyebrow">SERVER-SIDE WALLET SCAN · EC2 / LAMBDA</span><h2>Upload wallets, scan them on the server</h2></div></div>
      <p class="scan-intro">Upload a file of seeds, mnemonics, or private keys (one per line in <strong>.txt</strong>/<strong>.csv</strong>, or a JSON array). It is uploaded and a server job derives each wallet’s addresses for every supported network, fetches its <strong>holdings</strong> and <strong>USD value</strong>, and shows live progress. Empty wallets are hidden once the scan finishes; click a wallet’s <em>Export addr + seed</em> to download its address and seed phrase (sensitive).</p>
      <div class="scan-controls">
        <label class="file-drop" for="scan-file">
          <input id="scan-file" type="file" accept=".txt,.csv,.json,text/plain,application/json" hidden>
          <span class="file-drop-inner">${pendingFile ? escapeHtml(pendingFile.name) : 'Choose a <strong>.txt</strong> / <strong>.csv</strong> / <strong>.json</strong> file'}</span>
        </label>
        <button class="action-button" id="scan-start" type="button" ${pendingFile ? '' : 'disabled'}>Scan on server<span aria-hidden="true">↗</span></button>
      </div>
      <div class="scan-status" id="scan-status"></div>
      <div class="scan-results" id="scan-results"></div>
    </section>`;
}

function setScanStatus() {
  const el = document.querySelector('#scan-status');
  if (!el) return;
  const map = {
    idle: { cls: '', text: 'Choose a file and press “Scan on server”.' },
    uploading: { cls: 'is-busy', text: 'Uploading file…' },
    queued: { cls: 'is-busy', text: 'File uploaded — waiting for the scan to start…' },
    processing: { cls: 'is-busy', text: `Scanning… ${scanState.processed} / ${scanState.total} processed` },
    done: { cls: 'is-done', text: `Scan complete — ${scanState.results.filter((r) => r.valid).length} valid wallet(s) of ${scanState.results.length} entries.` },
    error: { cls: 'is-error', text: `Error: ${escapeHtml(scanState.error || 'unknown')}` },
  };
  const s = map[scanState.status] || { cls: '', text: '' };
  const pct = scanState.total ? Math.round((scanState.processed / scanState.total) * 100) : 0;
  const bar = scanState.status === 'processing' ? `<div class="scan-progress"><span style="width:${pct}%"></span></div>` : '';
  el.className = `scan-status ${s.cls}`;
  el.innerHTML = `${s.text}${bar}`;
}

function fmtUsd(value) {
  if (value == null) return '—';
  return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtAmt(value) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function walletHasFunds(result) {
  if (!result.balances) return true; // unknown -> keep
  return Object.values(result.balances).some((b) => b && (b.balance > 0 || (b.tokens && b.tokens.some((t) => t && t.balance > 0))));
}

function renderScanResults() {
  const el = document.querySelector('#scan-results');
  if (!el) return;
  if (!scanState.results.length) { el.innerHTML = ''; return; }

  const hideEmpty = scanState.hideEmpty !== false;
  const visible = scanState.results.filter((r) => {
    if (!r.valid) return true;            // always keep invalid/unknown rows
    if (scanState.status !== 'done') return true; // don't filter mid-scan
    return !hideEmpty || walletHasFunds(r); // hide confirmed-empty wallets when done
  });

  const totalValue = scanState.results
    .filter(walletHasFunds)
    .reduce((sum, r) => sum + (r.totalValueUsd || 0), 0);
  const anyMock = scanState.results.some((r) => r.mocked);
  const fundedCount = visible.filter((r) => r.valid && walletHasFunds(r)).length;

  const summary = `<div class="scan-summary">
    <div class="scan-summary-line"><b>${fundedCount}</b> wallet(s) with funds · total value <b>${fmtUsd(totalValue)}</b></div>
    ${anyMock ? '<div class="scan-mock-note">Demo balances (mock). Set MOCK_BALANCES=0 and deploy the Lambda (which has internet) for live holdings + prices.</div>' : ''}
    <label class="scan-toggle"><input type="checkbox" id="scan-hide-empty" ${hideEmpty ? 'checked' : ''}> Hide empty wallets</label>
  </div>`;

  const rows = visible.map((r, i) => {
    const statusBadge = r.valid ? '<span class="scan-ok">VALID</span>' : (r.kind === 'blank' ? '' : '<span class="scan-bad">INVALID</span>');
    const note = r.valid ? '' : (r.reason ? `<small class="scan-reason">${escapeHtml(r.reason)}</small>` : '');
    let assets = '—';
    if (r.balances) {
      const parts = [];
      for (const [id, b] of Object.entries(r.balances)) {
        if (!b) continue;
        if (b.error) { parts.push(`${b.symbol}: <span class="scan-err">${escapeHtml(b.error)}</span>`); continue; }
        if (b.balance > 0) parts.push(`<span class="scan-asset"><b>${escapeHtml(b.symbol)}</b> ${fmtAmt(b.balance)} <span class="scan-val">(${fmtUsd(b.valueUsd)})</span></span>`);
        if (b.tokens && b.tokens.length) {
          for (const t of b.tokens) {
            if (t.error) { parts.push(`${t.symbol}: <span class="scan-err">${escapeHtml(t.error)}</span>`); continue; }
            if (t.balance > 0) parts.push(`<span class="scan-asset scan-token"><b>${escapeHtml(t.symbol)}</b> ${fmtAmt(t.balance)} <span class="scan-val">(${fmtUsd(t.valueUsd)})</span></span>`);
          }
        }
      }
      assets = parts.length ? parts.join(' ') : '<span class="scan-empty">empty</span>';
    }
    const exportBtn = r.valid ? `<button class="copy-button scan-export" data-export-index="${r.index}" type="button">Export addr + seed</button>` : '';
    return `<tr>
      <td class="scan-idx">${i + 1}</td>
      <td class="scan-input"><code>${escapeHtml(r.input || '')}</code>${note}</td>
      <td>${statusBadge}</td>
      <td class="scan-assets"><button class="scan-assets-open" data-detail-index="${r.index}" type="button" ${r.valid ? '' : 'disabled'} aria-label="View ${escapeHtml(r.input || 'wallet')} assets">${assets}<span class="scan-view-hint">View / export</span></button></td>
      <td class="scan-total">${r.valid ? fmtUsd(r.totalValueUsd) : '—'}</td>
      <td>${exportBtn}</td>
    </tr>`;
  }).join('');

  const download = scanState.status === 'done' ? `<div class="scan-download"><button class="copy-button" id="scan-download" type="button">Download results (JSON)</button></div>` : '';
  el.innerHTML = `${download}${summary}<div class="scan-table-wrap"><table class="scan-table"><thead><tr><th>#</th><th>Wallet (seed / private key)</th><th>Status</th><th>Assets · balance · USD value</th><th>Wallet value</th><th>Export</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  document.querySelector('#scan-download')?.addEventListener('click', downloadScanResults);
  document.querySelector('#scan-hide-empty')?.addEventListener('change', (event) => {
    scanState.hideEmpty = event.target.checked;
    renderScanResults();
  });
  el.querySelectorAll('[data-export-index]').forEach((node) => node.addEventListener('click', () => exportWallet(Number(node.dataset.exportIndex))));
  el.querySelectorAll('[data-detail-index]').forEach((node) => node.addEventListener('click', () => showWalletDetails(Number(node.dataset.detailIndex))));
}

function showWalletDetails(index) {
  const result = scanState.results[index];
  if (!result || !result.valid) return;
  document.querySelector('#wallet-details-dialog')?.remove();
  const assetRows = [];
  for (const [network, balance] of Object.entries(result.balances || {})) {
    if (balance?.balance > 0) assetRows.push(`<li><b>${escapeHtml(balance.symbol)}</b> ${fmtAmt(balance.balance)} (${fmtUsd(balance.valueUsd)}) · ${escapeHtml(network)}</li>`);
    for (const token of balance?.tokens || []) {
      if (token?.balance > 0) assetRows.push(`<li><b>${escapeHtml(token.symbol)}</b> ${fmtAmt(token.balance)} (${fmtUsd(token.valueUsd)}) · ${escapeHtml(network)}</li>`);
    }
  }
  const addressRows = Object.entries(result.addresses || {}).map(([network, address]) => `<li><b>${escapeHtml(network)}</b><code>${escapeHtml(address)}</code></li>`).join('');
  const dialog = document.createElement('dialog');
  dialog.id = 'wallet-details-dialog';
  dialog.className = 'wallet-details-dialog';
  dialog.innerHTML = `<div class="wallet-details-heading"><div><span class="eyebrow">ASSET DETAILS</span><h2>${fmtUsd(result.totalValueUsd)} total</h2></div><button type="button" class="reverse-toggle" data-close-details>Close</button></div><h3>Holdings</h3><ul>${assetRows.length ? assetRows.join('') : '<li>No reported assets with a balance.</li>'}</ul><h3>Wallet addresses</h3><ul class="wallet-address-list">${addressRows}</ul><p class="hash-footnote">Exporting includes sensitive recovery material. Anyone with the seed phrase or private key can control the wallet.</p><button type="button" class="action-button" data-detail-export>Export address + seed</button>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-close-details]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector('[data-detail-export]').addEventListener('click', () => exportWallet(index));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

function exportWallet(index) {
  const result = scanState.results[index];
  if (!result || !result.valid) return;
  const confirmed = window.confirm('This TXT file contains the wallet’s seed phrase / private key AND its addresses. It is sensitive — keep it private. Continue?');
  if (!confirmed) return;
  const lines = ['WALLET EXPORT (educational / test data only)', `seed-or-private-key: ${result.input}`];
  if (result.addresses) {
    for (const [id, addr] of Object.entries(result.addresses)) lines.push(`${id}: ${addr}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wallet-export.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadScanResults() {
  const blob = new Blob([JSON.stringify(scanState.results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wallet-scan-results.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function startScan() {
  if (!pendingFile) return;
  scanState = { jobId: null, status: 'uploading', total: 0, processed: 0, results: [], error: null, hideEmpty: true };
  setScanStatus();
  renderScanResults();
  try {
    const fd = new FormData();
    fd.append('file', pendingFile, pendingFile.name);
    const res = await fetch(`${API_BASE}/api/scan`, { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      scanState.status = 'error';
      scanState.error = e.error || `HTTP ${res.status}`;
      setScanStatus();
      return;
    }
    const data = await res.json();
    scanState.jobId = data.jobId;
    if (data.uploadUrl) {
      scanState.status = 'queued';
      setScanStatus();
      const put = await fetch(data.uploadUrl, { method: 'PUT', body: pendingFile, headers: { 'content-type': 'application/octet-stream' } });
      if (!put.ok) {
        scanState.status = 'error';
        scanState.error = 'S3 upload failed';
        setScanStatus();
        return;
      }
    }
    pollScan(data.jobId);
  } catch (err) {
    scanState.status = 'error';
    scanState.error = err.message;
    setScanStatus();
  }
}

async function pollScan(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/scan/${jobId}`);
    if (!res.ok) return;
    const job = await res.json();
    scanState.status = job.status;
    scanState.total = job.total || 0;
    scanState.processed = job.processed || 0;
    scanState.results = job.results || [];
    scanState.error = job.error || null;
    setScanStatus();
    renderScanResults();
    if (job.status === 'done' || job.status === 'error') return;
    setTimeout(() => pollScan(jobId), 800);
  } catch {
    setTimeout(() => pollScan(jobId), 1500);
  }
}

function pointSearchStatusMarkup() {
  const { progress, result, error, busy, count } = pointSearch;
  if (error) return `<div class="dlog-warning" role="alert"><strong>Public-key search failed.</strong>${escapeHtml(error)}${pointSearch.backend !== 'cpu' ? '<p>No completed result was reported. You can retry the same file and bounds using CPU-only mode.</p><button class="dlog-stop-button" id="point-retry-cpu" type="button">Retry using CPU</button>' : ''}</div>`;
  if (busy) {
    if (!progress) return `<div class="dlog-live-progress" role="status">Running interval ${escapeHtml(pointSearch.runningLower)}–${escapeHtml(pointSearch.runningUpper)} · Validating uploaded keys${count ? ` · ${count.toLocaleString()} valid rows` : '…'}</div>`;
    return `<div class="dlog-live-progress" role="status"><b>Giant-step slots checked: ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}</b><div class="search-progress"><span style="width:${Number(progress.completed * 10000n / progress.total) / 100}%"></span></div><p>Running interval ${escapeHtml(pointSearch.runningLower)}–${escapeHtml(pointSearch.runningUpper)} · ${progress.workers} workers · ${progress.cpuWorkers} CPU-only + ${progress.gpuWorkers} WebGPU-assisted · ${count.toLocaleString()} public keys · ${progress.matches} verified matches · ${Math.round(Number(progress.completed) * 1000 / Math.max(progress.elapsedMs, 1)).toLocaleString()} slots/second (includes already-matched targets; not address candidates/second).</p></div>`;
  }
  if (!result) return '<p class="dlog-placeholder">Upload an exported public-key TXT to begin.</p>';
  const cancelled = result.status === 'cancelled';
  const matches = result.matches.map((match) => `<li><strong>${escapeHtml(match.address)}</strong><br>Decimal scalar: <code>${escapeHtml(match.scalar)}</code><br>Collision point: <code>${escapeHtml(match.collisionPoint)}</code><br>Baby step ${match.babyStep}; giant step ${match.giantStep} · Q = dG verified</li>`).join('');
  return `<div class="dlog-live-progress" role="status"><b>${cancelled ? 'Stopped — partial search' : 'Complete'} · ${result.matches.length} verified match(es)</b><p>${result.completed.toLocaleString()} / ${result.total.toLocaleString()} giant-step slots · ${result.targetCount.toLocaleString()} targets · ${result.workers ?? 0} workers · ${result.cpuWorkers ?? 0} CPU-only + ${result.gpuWorkers ?? 0} WebGPU-assisted · interval ${escapeHtml(result.lower)}–${escapeHtml(result.upper)} · ${(result.elapsedMs / 1000).toFixed(1)} seconds.</p><p>${cancelled ? 'No conclusions can be drawn about unsearched steps.' : 'A miss rules out only this interval for the supplied public keys.'}</p>${matches ? `<p>Matching scalars are sensitive private-key material. Do not share them.</p><ul class="point-matches">${matches}</ul>` : ''}</div>`;
}

function gpuBenchmarkReport(result) {
  return JSON.stringify({
    benchmark: 'Seedlab synthetic WebGPU collision lookup',
    adapter: result.adapter, adapterPreference: result.preference, executionPath: result.path,
    verified: result.verified, measuredBatches: result.rounds, queriesPerBatch: result.batchSize,
    lookups: result.lookups, elapsedMs: Math.round(result.elapsedMs),
    lookupsPerSecond: Math.round(result.lookupsPerSecond),
    medianBatchMs: Number(result.medianBatchMs.toFixed(2)), p95BatchMs: Number(result.p95BatchMs.toFixed(2)),
    note: 'Synthetic GPU lookup/readback and CPU verification only; not full BSGS, ECC operations, or address candidates per second.',
  }, null, 2);
}

function gpuBenchmarkStatusMarkup() {
  if (gpuBenchmark.error) return `<p class="kangaroo-error" role="alert">${escapeHtml(gpuBenchmark.error)}</p>`;
  if (gpuBenchmark.busy) return `<p class="step-explanation" role="status">${gpuBenchmark.progress ? `Measured ${gpuBenchmark.progress.completedRounds} / ${gpuBenchmark.progress.rounds} batches…` : 'Preparing the WebGPU benchmark…'}</p>`;
  if (!gpuBenchmark.result) return '<p class="dlog-placeholder">No benchmark run yet.</p>';
  if (gpuBenchmark.result.status === 'cancelled') return '<p class="step-explanation" role="status">Benchmark stopped; no throughput result was recorded.</p>';
  return `<div class="dlog-live-progress" role="status"><b>${Math.round(gpuBenchmark.result.lookupsPerSecond).toLocaleString()} verified lookups/second</b><p>Includes upload, dispatch, readback and CPU verification; excludes adapter/table setup and warm-up. This is not full search speed or address candidates per second.</p><pre class="gpu-benchmark-report">${escapeHtml(gpuBenchmarkReport(gpuBenchmark.result))}</pre><button class="search-file-button" id="copy-gpu-benchmark" type="button">Copy benchmark result</button></div>`;
}

function startGpuBenchmark() {
  if (gpuBenchmark.busy || pointSearch.busy) return;
  gpuBenchmark = { ...gpuBenchmark, busy: true, progress: null, result: null, error: '' };
  render();
  let worker, host;
  const finish = (result, error) => {
    if (gpuBenchmarkWorker !== worker) return;
    host?.close(); worker?.terminate(); gpuBenchmarkWorker = null;
    gpuBenchmark.busy = false; gpuBenchmark.result = result ?? null; gpuBenchmark.error = error ?? '';
    render();
  };
  try {
    worker = new Worker(new URL('./gpu-benchmark-worker.js', import.meta.url), { type: 'module' });
    gpuBenchmarkWorker = worker;
    host = createGpuBridgeHost(worker);
    worker.onmessage = ({ data }) => {
      if (gpuBenchmarkWorker !== worker) return;
      if (data.type === 'gpu-request') { void host.handle(data); return; }
      if (data.type === 'result') { finish(data.result, ''); return; }
      if (data.type === 'error') { finish(null, data.message); return; }
      if (data.type === 'progress') {
        gpuBenchmark.progress = data;
        const status = document.querySelector('#gpu-benchmark-status');
        if (status) status.innerHTML = gpuBenchmarkStatusMarkup();
      }
    };
    worker.onerror = (error) => finish(null, error.message || 'GPU benchmark worker failed.');
    worker.postMessage({ type: 'start', preference: gpuBenchmark.preference });
  } catch (error) {
    if (worker) { gpuBenchmarkWorker = worker; finish(null, error?.message ?? String(error)); }
    else { gpuBenchmark.busy = false; gpuBenchmark.error = error?.message ?? String(error); render(); }
  }
}

function plannerNumber(value) {
  if (value === 0) return '0';
  return value >= 1e6 || value < 0.001 ? value.toExponential(3) : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

function rangePlannerOutput() {
  try {
    const plan = planRange(pointSearch.lower.trim(), pointSearch.upper.trim(), rangePlanner.targets.trim(), rangePlanner.rate);
    return `<p><b>Inclusive interval:</b> ${escapeHtml(plan.count.toLocaleString())} scalars · <b>Chunks:</b> ${escapeHtml(plan.chunks.toLocaleString())}</p><p><b>Coverage / chance for one uniformly random key:</b> ${plannerNumber(plan.fraction)} (${plannerNumber(plan.fraction * 100)}%)</p><p><b>Planned giant-step slots:</b> ${escapeHtml(plan.work.toLocaleString())} for ${plan.targets.toLocaleString()} target(s)${plan.seconds === null ? '' : ` · <b>slot-only time:</b> ${plannerNumber(plan.seconds)} seconds (${plannerNumber(plan.seconds / 31557600)} years)`}</p><p>Conditional on a uniformly random private scalar; this is not a prediction for a particular public key. Work assumes all targets are searched through the whole interval. A time estimate excludes setup, table construction and other overhead, and assumes your measured search rate remains constant; it is not a guarantee. GPU benchmark lookups/sec is not a search rate.</p>`;
  } catch (error) { return `<p class="kangaroo-error">${escapeHtml(error.message)}</p>`; }
}

function updateRangePlanner() {
  const output = document.querySelector('#range-planner-output');
  if (output) output.innerHTML = rangePlannerOutput();
  const error = document.querySelector('#range-planner-error');
  if (error) error.textContent = rangePlanner.error;
}

function pointSearchMarkup() {
  return `<section class="backward-panel dlog-panel" id="public-key-search">
    <div class="backward-heading"><div><span class="eyebrow">PUBLIC-KEY SEARCH · LOCAL ONLY</span><h3>Search uploaded Ethereum public keys</h3></div><span class="live-example">PARALLEL BSGS</span></div>
    <p class="backward-intro">Upload the tab-separated TXT exported by “Extract public keys”. This uses parallel baby-step giant-step (BSGS), not kangaroo, to search every validated public point in the same inclusive interval. Workers share the targets; each uses its own table. The file stays in this browser.</p>
    <div class="search-file-row"><div class="search-file-copy"><strong>Ethereum public-key TXT</strong><small>Columns: address, transaction_hash, public_key_uncompressed, status; tab separated, status ok. Up to 10,000 rows and 5 MB. All rows must validate.</small></div><label class="search-file-button ${pointSearch.busy ? 'is-disabled' : ''}" for="point-search-file">Choose TXT</label><input id="point-search-file" type="file" accept=".txt,text/plain,.tsv,text/tab-separated-values" hidden ${pointSearch.busy ? 'disabled' : ''}><span class="search-file-name">${escapeHtml(pointSearch.fileName || 'No file selected')}</span></div>
    <div class="candidate-range"><label>Lower scalar (inclusive)<input id="point-search-lower" type="text" inputmode="numeric" value="${escapeHtml(pointSearch.lower)}"></label><label>Upper scalar (inclusive)<input id="point-search-upper" type="text" inputmode="numeric" value="${escapeHtml(pointSearch.upper)}"></label></div>
    <div class="gpu-benchmark-panel"><span class="eyebrow">EVIDENCE-BASED RANGE PLANNER</span><h3>Understand your search range</h3><p>Use bounds supported by evidence, such as a published puzzle range. A public key does not reveal its private scalar’s bit length. No region is more likely for a uniformly random key.</p><div class="candidate-range"><label>Known exact bit length (optional)<input id="planner-bits" type="number" min="1" max="256" value="${escapeHtml(rangePlanner.bits)}" placeholder="e.g. 20"></label><label>Estimated target count<input id="planner-targets" type="number" min="1" max="10000" value="${escapeHtml(rangePlanner.targets)}"></label><label>Measured search slots/second (optional)<input id="planner-rate" type="number" min="0" value="${escapeHtml(rangePlanner.rate)}" placeholder="From a prior search"></label></div><div class="dlog-actions"><button class="search-file-button" id="planner-apply-bits" type="button">Apply bit-length bounds</button></div><p id="range-planner-error" class="kangaroo-error" role="alert">${escapeHtml(rangePlanner.error)}</p><div id="range-planner-output" aria-live="polite">${rangePlannerOutput()}</div></div>
    <div class="point-worker-control"><label for="point-search-backend">Compute mode</label><select id="point-search-backend" ${pointSearch.busy ? 'disabled' : ''}><option value="cpu" ${pointSearch.backend === 'cpu' ? 'selected' : ''}>CPU only</option><option value="webgpu-high" ${pointSearch.backend === 'webgpu-high' ? 'selected' : ''}>WebGPU · high-performance preference</option><option value="webgpu-low" ${pointSearch.backend === 'webgpu-low' ? 'selected' : ''}>WebGPU · low-power preference</option><option value="hybrid-high" ${pointSearch.backend === 'hybrid-high' ? 'selected' : ''}>Hybrid CPU + WebGPU · high-performance preference</option><option value="hybrid-low" ${pointSearch.backend === 'hybrid-low' ? 'selected' : ''}>Hybrid CPU + WebGPU · low-power preference</option></select><small>Experimental: GPU performs collision table lookups; CPU performs curve math and checks every GPU result. May be slower than CPU-only. Requires WebGPU in a secure context; if unavailable in a worker, the app checks the browser window. Adapter preference does not guarantee a specific GPU. Hybrid divides keys among CPU and WebGPU-assisted workers; it requires at least 2 workers and 2 keys. WebGPU-assisted groups use at most 2 workers. Full GPU elliptic-curve arithmetic is not implemented.</small></div>
    <div class="point-worker-control"><label for="point-search-workers">CPU workers</label><select id="point-search-workers" ${pointSearch.busy ? 'disabled' : ''}><option value="auto" ${pointSearch.workers === 'auto' ? 'selected' : ''}>Auto (up to 8)</option>${Array.from({ length: 32 }, (_, i) => `<option value="${i + 1}" ${pointSearch.workers === String(i + 1) ? 'selected' : ''}>${i + 1}</option>`).join('')}</select><small>CPU only · actual workers cannot exceed the number of targets. More workers increase CPU and memory use and may be slower. Your browser reports ${escapeHtml(navigator.hardwareConcurrency || 'unknown')} logical cores.</small></div>
    <p class="step-explanation subtle">You can edit bounds during a run; changes apply to the next search. Current run bounds remain unchanged.</p>
    <div class="dlog-warning"><strong>Bounded test only.</strong> Bounds may span the valid secp256k1 private scalar range: 1 to curve order minus one, which is slightly below 2²⁵⁶. The search processes at most 100,000,000 scalars per internal chunk. Large intervals can take vastly longer than a human lifetime; a full-range search is infeasible. No interval is more likely for a randomly generated key. Use only keys you are authorized to test.</div>
    <div class="dlog-actions"><button class="action-button" id="point-search-start" type="button" ${pointSearch.busy || gpuBenchmark.busy || !pointSearch.text ? 'disabled' : ''}>Search uploaded public keys <span aria-hidden="true">↗</span></button>${pointSearch.busy ? '<button class="dlog-stop-button" id="point-search-stop" type="button">Stop search</button>' : ''}</div>
    <div id="point-search-status">${pointSearchStatusMarkup()}</div>
    <div class="gpu-benchmark-panel"><div><span class="eyebrow">LOCAL · SYNTHETIC</span><h3>Benchmark your GPU</h3><p>Tests verified GPU table lookups only. No uploaded keys are used or sent. Copy the result to share it.</p></div><div class="point-worker-control"><label for="gpu-benchmark-preference">Adapter preference</label><select id="gpu-benchmark-preference" ${gpuBenchmark.busy ? 'disabled' : ''}><option value="high-performance" ${gpuBenchmark.preference === 'high-performance' ? 'selected' : ''}>High-performance preference</option><option value="low-power" ${gpuBenchmark.preference === 'low-power' ? 'selected' : ''}>Low-power preference</option></select><small>Browser may ignore this preference and redact adapter details. Results do not measure GPU elliptic-curve arithmetic.</small></div><div class="dlog-actions"><button class="action-button" id="run-gpu-benchmark" type="button" ${gpuBenchmark.busy || pointSearch.busy ? 'disabled' : ''}>Run GPU benchmark</button>${gpuBenchmark.busy ? '<button class="dlog-stop-button" id="stop-gpu-benchmark" type="button">Stop benchmark</button>' : ''}</div><div id="gpu-benchmark-status">${gpuBenchmarkStatusMarkup()}</div></div>
  </section>`;
}

function startPointSearch() {
  if (!pointSearch.text || pointSearch.busy || gpuBenchmark.busy) return;
  pointSearch = { ...pointSearch, busy: true, progress: null, result: null, error: '', count: 0, runningLower: pointSearch.lower.trim(), runningUpper: pointSearch.upper.trim() };
  render();
  const pool = createPublicKeySearchPool({
    createWorker: () => new Worker(new URL('./public-key-search-worker.js', import.meta.url), { type: 'module' }),
    text: pointSearch.text, lower: pointSearch.runningLower, upper: pointSearch.runningUpper,
    cores: navigator.hardwareConcurrency, backend: pointSearch.backend, requestedWorkers: pointSearch.workers === 'auto' ? null : Number(pointSearch.workers),
    onUpdate: (progress) => {
      if (pointSearchPool !== pool) return;
      pointSearch.count = progress.count;
      pointSearch.progress = progress;
      const status = document.querySelector('#point-search-status');
      if (status) status.innerHTML = pointSearchStatusMarkup();
    },
    onFinish: ({ result, error }) => {
      if (pointSearchPool !== pool) return;
      pointSearchPool = null; pointSearch.busy = false;
      if (result) pointSearch.result = result; else pointSearch.error = error;
      render();
    },
  });
  pointSearchPool = pool;
  pool.start();
}

function kangarooDemoMarkup() {
  const result = kangarooDemoResult;
  return `<section class="kangaroo-demo-card exchange-card" id="kangaroo-demo">
    <div class="exchange-panel-heading"><div><span class="eyebrow">ALGORITHM LAB · BOUNDED DISCRETE LOG</span><h2>Pollard kangaroo</h2><p>Watch a toy tame/wild walk collide and recover a deliberately small test scalar.</p></div><span class="demo-mode-pill">SYNTHETIC TEST ONLY</span></div>
    <div class="kangaroo-summary-grid"><div><span>TOY INTERVAL</span><b>100,000 — 1,100,000</b></div><div><span>PUBLIC POINT</span><b>Q = dG</b></div><div><span>WORK PROFILE</span><b>O(√N) · probabilistic</b></div></div>
    <div class="kangaroo-steps"><div><i>01</i><span><b>Tame walk</b><small>Stores visited points from N·G.</small></span></div><div><i>02</i><span><b>Wild walk</b><small>Starts from Q − L·G and follows the same jumps.</small></span></div><div><i>03</i><span><b>Collision</b><small>Uses the distance difference, then verifies Q = dG.</small></span></div></div>
    <div class="kangaroo-run-row"><button class="action-button kangaroo-run-button" id="run-kangaroo-demo" type="button" ${kangarooDemoBusy ? 'disabled' : ''}>${kangarooDemoBusy ? 'Running toy walk…' : result ? 'Run demo again' : 'Run kangaroo demo'}<span aria-hidden="true">↗</span></button><span class="kangaroo-run-note">No wallet addresses, transaction hashes, or user keys are used.</span></div>
    ${kangarooDemoError ? `<p class="kangaroo-error" role="alert">${escapeHtml(kangarooDemoError)}</p>` : ''}
    ${result ? `<div class="kangaroo-result"><div><span>RECOVERED TOY PRIVATE SCALAR</span><b>${BigInt(result.recovered).toLocaleString()}</b></div><div><span>TAME / WILD STEPS</span><b>${result.tameSteps.toLocaleString()} / ${result.wildSteps.toLocaleString()}</b></div><div><span>WALK RATE · NOT CANDIDATES/S</span><b>${Math.round(result.walkStepsPerSecond).toLocaleString()} steps/s</b></div><div><span>VERIFY Q = dG</span><b class="${result.verified ? 'verified' : 'unverified'}">${result.verified ? 'PASSED' : 'FAILED'}</b></div></div>
      <div class="kangaroo-trace"><div class="trace-heading"><div><span class="eyebrow">RUN TRACE</span><h3>How the toy scalar was recovered</h3></div><span class="trace-result-chip">COLLISION FOUND</span></div><ol>
        <li><i>01</i><div><b>Set the bounded interval</b><p><code>L = ${BigInt(result.lower).toLocaleString()}</code>, <code>U = ${BigInt(result.upper).toLocaleString()}</code>, so <code>N = U − L = ${BigInt(result.width).toLocaleString()}</code>.</p></div></li>
        <li><i>02</i><div><b>Shift the target point</b><p>Compute <code>Q′ = Q − L·G</code>. This moves the unknown offset into <code>[0, N]</code>.</p><code class="trace-hex">${escapeHtml(result.shiftedTarget)}</code></div></li>
        <li><i>03</i><div><b>Run the tame walk</b><p>Start at <code>T₀ = N·G</code>; interleave the tame and wild walks and record visited points and cumulative distances. The collision table stored the matching point at step ${result.collision.tameStep.toLocaleString()} with distance <code>t = ${BigInt(result.collision.tameDistance).toLocaleString()}</code>.</p></div></li>
        <li><i>04</i><div><b>Run the wild walk</b><p>Start from <code>Q′</code>, choose the same deterministic jumps, and reach that point at step ${result.collision.wildStep.toLocaleString()} with distance <code>w = ${BigInt(result.collision.wildDistance).toLocaleString()}</code>.</p></div></li>
        <li><i>05</i><div><b>Use the collision to solve for the scalar</b><p>At collision, <code>N + t = (d − L) + w</code>, therefore:</p><code class="trace-equation">d = L + N + t − w = ${BigInt(result.lower).toLocaleString()} + ${BigInt(result.width).toLocaleString()} + ${BigInt(result.collision.tameDistance).toLocaleString()} − ${BigInt(result.collision.wildDistance).toLocaleString()} = ${BigInt(result.recovered).toLocaleString()}</code></div></li>
        <li><i>06</i><div><b>Verify the answer</b><p>Recompute <code>d·G</code> and compare it to <code>Q</code>: <strong class="${result.verified ? 'verified' : 'unverified'}">${result.verified ? 'MATCH' : 'NO MATCH'}</strong>. This recovered value is only the fixed synthetic demo scalar.</p></div></li>
      </ol><details><summary>Show toy public point and collision</summary><div class="trace-point-pair"><code>Q = ${escapeHtml(result.targetPoint)}</code><code>collision = ${escapeHtml(result.collision.point)}</code></div></details></div>` : '<div class="kangaroo-placeholder"><span class="pulse-ring"></span><div><b>Demo ready</b><small>Run it to see a walk summary and the collision equation.</small></div></div>'}
  </section>`;
}

function runKangarooDemoFromUi() {
  kangarooDemoBusy = true;
  kangarooDemoError = '';
  render();
  let worker;
  const finish = (result, error) => {
    worker?.terminate();
    kangarooDemoResult = result?.verified && result.recovered ? result : null;
    kangarooDemoError = error || (!kangarooDemoResult ? 'The toy walk did not find a verified result.' : '');
    kangarooDemoBusy = false;
    render();
  };
  try {
    worker = new Worker(new URL('./kangaroo-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => finish(data.result, data.error);
    worker.onerror = (error) => finish(null, error.message || 'The demo worker failed.');
    worker.postMessage({});
  } catch (error) {
    finish(null, error?.message ?? String(error));
  }
}

function render() {
  const scalarFocus = captureScalarFocus(document);
  const activeNetwork = selectedNetwork();
  const pathSegments = activeNetwork.path.slice(2).split('/');
  const entropyReady = wallet.stage >= 1;
  const words = entropyReady ? wallet.phrase.split(' ') : [];
  const wordGrid = words.map((word, index) => {
    const wordIndex = wordlist.indexOf(word);
    const bits = wallet.wordChunks[index] ?? '';
    return `<div class="mnemonic-word"><span>${String(index + 1).padStart(2, '0')}</span><b>${word}</b><small>${String(wordIndex).padStart(4, '0')} · ${bits}</small></div>`;
  }).join('');

  const entropyBody = entropyReady ? `
    <div class="value-row"><div><label>128-bit entropy · 16 bytes</label><code>${spacedHex(wallet.entropy)}</code></div>${copyButton('entropy')}</div>
    <div class="value-row"><div><label>SHA-256(entropy) · full 256-bit digest</label><code>${spacedHex(wallet.entropyHash)}</code></div>${copyButton('entropyHash')}</div>
    <div class="checksum-strip"><span class="mini-label">CHECKSUM BITS USED · FIRST 4 OF SHA-256</span><code>${wallet.entropyChecksum}</code><span class="checksum-explain">The other 252 hash bits are not part of the mnemonic.</span></div>
    <div class="mnemonic-grid">${wordGrid}</div>
    <p class="step-explanation">Concatenate 128 entropy bits + 4 checksum bits = 132 bits. Split into twelve 11-bit integers; each integer selects one word-list entry. The word indices preserve all 128 entropy bits; the checksum bits only detect mistakes.</p>` : `
    <p class="step-explanation">Generate 16 cryptographically random bytes. Hash them with SHA-256, take the first 4 hash bits as checksum, append them to entropy, and split into twelve 11-bit word-list indices.</p>
    <div class="empty-inline">No phrase or keys exist until you generate a demo wallet.</div>`;

  const phraseBody = entropyReady ? `
    <div class="phrase-title-row"><span class="mini-label">12-WORD BIP-39 MNEMONIC</span>${copyButton('phrase', 'Copy phrase')}</div>
    <div class="mnemonic-grid compact-words">${wordGrid}</div>
    <p class="step-explanation">The phrase is the human-readable encoding of the entropy plus checksum. It is not the 512-bit seed or any chain’s address.</p>` : '<p class="locked-note">The twelve-word phrase is produced from the entropy and checksum above.</p>';

  const seedBody = wallet.stage >= 2 ? `
    <div class="formula-line"><span>PBKDF2-HMAC-SHA512</span><span>2,048 rounds</span><span>output: 64 bytes</span></div>
    <p class="step-explanation">Input: NFKD-normalized mnemonic. Salt bytes: UTF-8 of <code>mnemonic</code> + NFKD(optional passphrase). PBKDF2 iterates HMAC-SHA512 2,048 times and emits 64 bytes. The output is deterministic, but it is not an encrypted copy of its inputs.</p>
    <div class="value-row"><div><label>Salt · UTF-8 bytes, shown as hex</label><code>${spacedHex(wallet.bip39Salt)}</code></div>${copyButton('salt')}</div>
    <div class="value-row"><div><label>512-bit BIP-39 seed · 64 bytes</label><code>${spacedHex(wallet.seed)}</code></div>${copyButton('seed', 'Copy seed')}</div>` : '<p class="locked-note">This runs PBKDF2-HMAC-SHA512 on the phrase. The result is seed material—not a private key.</p>';

  const masterBody = wallet.stage >= 3 ? `
    <p class="step-explanation">BIP-32 computes HMAC-SHA512 with key = UTF-8 <code>Bitcoin seed</code> and data = the 64-byte seed. The 64-byte digest is split in half: IL becomes the master private scalar; IR becomes the master chain code.</p>
    <div class="value-row"><div><label>HMAC-SHA512 output · IL || IR · 64 bytes</label><code>${spacedHex(wallet.masterHmacOutput)}</code></div>${copyButton('masterHmac')}</div>
    <div class="value-row"><div><label>Master private key · IL · first 32 bytes</label><code>${spacedHex(wallet.master.privateKey)}</code></div>${copyButton('masterPrivate')}</div>
    <div class="value-row"><div><label>Master chain code · IR · final 32 bytes</label><code>${spacedHex(wallet.master.chainCode)}</code></div>${copyButton('chainCode')}</div>
    <p class="step-explanation subtle">The 64-byte seed is the HMAC input; the new 32-byte private key and 32-byte chain code are the carried-forward BIP-32 master node. The digest is not reversible to its input.</p>` : '<p class="locked-note">BIP-32 turns the seed into a master private key and chain code using HMAC-SHA512.</p>';

  const accountBody = wallet.stage >= 4 ? `
    <div class="path-value"><span class="mini-label">${activeNetwork.label.toUpperCase()} DERIVATION PATH</span><code>${activeNetwork.path}</code></div>
    <div class="path-legend">${pathSegments.map((segment, index) => `<span><b>${segment.replaceAll("'", '′')}</b> ${activeNetwork.pathLabels[index]}</span>`).join('')}</div>
    <p class="step-explanation">BIP-32 walks the selected path one child at a time. Each node carries a new private key and chain code forward. Hardened levels (′) use private parent material; this path is a wallet convention and is not embedded in the final address.</p>
    <div class="path-node-list">${wallet.pathNodes.map((entry) => `<details class="path-node"><summary><span>${entry.fullPath}</span><small>${entry.hardened ? 'HARDENED' : 'NORMAL'} · index 0x${entry.childIndex.toString(16).padStart(8, '0')}</small></summary><div class="value-row"><div><label>Child private key</label><code>${spacedHex(entry.node.privateKey)}</code></div></div><div class="value-row"><div><label>Child chain code</label><code>${spacedHex(entry.node.chainCode)}</code></div></div><div class="value-row"><div><label>Child compressed public key</label><code>${spacedHex(entry.node.publicKey)}</code></div></div></details>`).join('')}</div>
    <div class="value-row"><div><label>Final ${activeNetwork.label} account private key</label><code>${spacedHex(wallet.account.privateKey)}</code></div>${copyButton('accountPrivate')}</div>
    <div class="value-row"><div><label>Uncompressed secp256k1 public key · 65 bytes</label><code>${spacedHex(wallet.publicKey)}</code></div>${copyButton('publicKey')}</div>
    ${activeNetwork.family === 'bitcoin' || activeNetwork.family === 'bnbBeacon' ? `<div class="value-row"><div><label>Compressed public key · 33 bytes (used by ${activeNetwork.label})</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>` : ''}` : `<p class="locked-note">Derive the ${activeNetwork.label} account at <code>${activeNetwork.path}</code>, then compute its secp256k1 public key.</p>`;

  let addressBody;
  if (wallet.stage < 5) {
    addressBody = `<p class="locked-note">Derive the public key, then apply the ${activeNetwork.label} address encoding.</p>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2wpkh') {
    addressBody = `
      <p class="step-explanation">Bitcoin native SegWit P2WPKH uses the compressed secp256k1 public key. SHA-256 then RIPEMD-160 produces a 20-byte witness program. Bech32 encodes witness version 0 and the mainnet HRP <code>bc</code>.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · COMPRESSED PUBLIC KEY · 33 BYTES</label>${copyButton('compressedPublicKey', 'Copy key')}</div><div class="hash-byte-grid">${byteGrid(wallet.compressedPublicKey)}</div></div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>HASH160 · RIPEMD-160(SHA-256) · 20 bytes</label><code>${spacedHex(wallet.btcHash160)}</code></div>${copyButton('addressBytes', 'Copy program')}</div>
      <div class="hash-params"><span>WITNESS <b>version 0</b></span><span>HRP <b>bc</b></span><span>CHECKSUM <b>Bech32</b></span></div>
      <div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.btcHash160)}</div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · NATIVE SEGWIT P2WPKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2pkh') {
    addressBody = `
      <p class="step-explanation">Legacy Bitcoin P2PKH hashes the compressed public key with HASH160, prepends mainnet version byte <code>00</code>, appends a 4-byte double-SHA-256 checksum, then Base58Check encodes the 25 bytes.</p>
      <div class="value-row"><div><label>Compressed public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>HASH160 · 20 bytes</label><code>${spacedHex(wallet.btcHash160)}</code></div></div>
      <div class="value-row"><div><label>Payload · version 00 || HASH160 · 21 bytes</label><code>${spacedHex(wallet.btcPayload)}</code></div></div>
      <div class="value-row"><div><label>Base58Check checksum · 4 bytes</label><code>${spacedHex(wallet.btcChecksum)}</code></div></div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · LEGACY P2PKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2sh-p2wpkh') {
    addressBody = `
      <p class="step-explanation">Nested SegWit P2SH-P2WPKH creates redeem script <code>0014 || HASH160(compressed pubkey)</code>, then hashes that script with HASH160. Version <code>05</code> and a double-SHA-256 checksum are Base58Check encoded.</p>
      <div class="value-row"><div><label>Compressed public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>HASH160(compressed public key)</label><code>${spacedHex(wallet.btcHash160)}</code></div></div>
      <div class="value-row"><div><label>Redeem script · 00 14 || witness program · 22 bytes</label><code>${spacedHex(wallet.btcRedeemScript)}</code></div></div>
      <div class="value-row"><div><label>HASH160(redeem script)</label><code>${spacedHex(wallet.btcScriptHash)}</code></div></div>
      <div class="value-row"><div><label>P2SH payload · version 05 || script hash · 21 bytes</label><code>${spacedHex(wallet.btcPayload)}</code></div></div>
      <div class="value-row"><div><label>Base58Check checksum · 4 bytes</label><code>${spacedHex(wallet.btcChecksum)}</code></div></div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · NESTED SEGWIT P2SH-P2WPKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2tr') {
    addressBody = `
      <p class="step-explanation">BIP-86 Taproot normalizes the x-only internal point to even Y, applies tagged <code>TapTweak</code>, adds tweak·G, then encodes the x-only output key as witness v1 with Bech32m.</p>
      <div class="value-row"><div><label>Internal x-only public key · 32 bytes</label><code>${spacedHex(wallet.taprootData.internalX)}</code></div></div>
      <div class="value-row"><div><label>TaggedHash(TapTweak, internal key)</label><code>${spacedHex(wallet.taprootData.tweakHash)}</code></div></div>
      <div class="value-row"><div><label>TapTweak scalar</label><code>${spacedHex(wallet.taprootData.tweak)}</code></div></div>
      <div class="value-row"><div><label>Tweaked output public key · compressed</label><code>${spacedHex(wallet.taprootData.outputPublicKey)}</code></div></div>
      <div class="value-row"><div><label>Witness v1 program · x-only output key · 32 bytes</label><code>${spacedHex(wallet.taprootData.outputX)}</code></div></div>
      <p class="step-explanation subtle">BIP-86 tweaked private scalar (sensitive; keep private): <code>${hex(wallet.taprootData.outputPrivateKey)}</code></p>
      <div class="address-output"><div><span class="mini-label">BITCOIN · TAPROOT P2TR · BECH32M</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'tron') {
    addressBody = `
      <p class="step-explanation">TRON uses the uncompressed public key body (X || Y), Keccak-256, and the final 20 digest bytes. It prepends mainnet version byte <code>41</code>, appends the first 4 bytes of double-SHA-256 as a Base58Check checksum, then encodes the 25-byte result in Base58.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
      <div class="hash-block"><div class="hash-block-heading"><label>KECCAK-256 · FULL DIGEST · 32 BYTES</label></div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div></div>
      <div class="value-row"><div><label>Address payload · version 0x41 || 20 address bytes · 21 bytes</label><code>${spacedHex(wallet.tronPayload)}</code></div>${copyButton('tronPayload')}</div>
      <div class="value-row"><div><label>SHA-256(payload) · 32 bytes</label><code>${spacedHex(wallet.tronShaFirst)}</code></div>${copyButton('tronShaFirst')}</div>
      <div class="value-row"><div><label>SHA-256(previous digest) · 32 bytes</label><code>${spacedHex(wallet.tronShaSecond)}</code></div>${copyButton('tronShaSecond')}</div>
      <div class="value-row"><div><label>Checksum · first 4 bytes of second SHA-256</label><code>${spacedHex(wallet.tronChecksum)}</code></div>${copyButton('tronChecksum')}</div>
      <div class="value-row"><div><label>Base58Check input · payload || checksum · 25 bytes</label><code>${spacedHex(wallet.tronBase58Bytes)}</code></div>${copyButton('tronBase58Bytes')}</div>
      <div class="address-output"><div><span class="mini-label">TRON MAINNET · BASE58CHECK</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bnbBeacon') {
    addressBody = `
      <p class="step-explanation">BNB Beacon Chain (legacy BEP2, historical/reference profile) uses path <code>${activeNetwork.path}</code>. It hashes the compressed secp256k1 public key with SHA-256 then RIPEMD-160, and Bech32-encodes the 20-byte result with HRP <code>bnb</code>. This differs from EVM-compatible BNB Smart Chain.</p>
      <div class="value-row"><div><label>Compressed secp256k1 public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>RIPEMD-160 · 20-byte address payload</label><code>${spacedHex(wallet.btcHash160)}</code></div>${copyButton('addressBytes', 'Copy payload')}</div>
      <div class="hash-params"><span>HRP <b>bnb</b></span><span>ENCODING <b>Bech32</b></span><span>PAYLOAD <b>20 bytes</b></span></div>
      <div class="address-output"><div><span class="mini-label">BNB BEACON CHAIN · BECH32</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else {
    addressBody = `
      <p class="step-explanation">${activeNetwork.family === 'evm' && selectedNetworkId === 'bnb' ? 'BNB Smart Chain is EVM-compatible: it uses the same secp256k1 public key, Keccak-256 address construction, and BIP-44 coin type 60 as Ethereum. The address is identical on both networks; the chain selection tells you which network to use.' : 'Ethereum derives its address from the uncompressed public-key body (X || Y): Keccak-256, then the final 20 digest bytes, followed by EIP-55 display casing.'}</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES · PREFIX 04 OMITTED</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
      <div class="hash-params"><span>KECCAK RATE <b>136 bytes</b></span><span>CAPACITY <b>64 bytes</b></span><span>ROUNDS <b>24</b></span><span>OUTPUT <b>32 bytes</b></span></div>
      <div class="hash-block"><div class="hash-block-heading"><label>OUTPUT · FULL KECCAK-256 DIGEST · 32 BYTES</label>${copyButton('keccak', 'Copy hash')}</div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div><p class="hash-footnote">Digest bytes 12–31 (highlighted) form the 20-byte address; the first 12 bytes are discarded. Ethereum/BNB use legacy Keccak padding, not standardized SHA3-256.</p></div>
      <div class="hash-block"><div class="hash-block-heading"><label>ADDRESS PAYLOAD · 20 RAW BYTES</label>${copyButton('addressBytes', 'Copy bytes')}</div><div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.addressBytes)}</div></div>
      <div class="value-row"><div><label>EIP-55 hash · Keccak-256 of lowercase address text</label><code>${spacedHex(wallet.eip55Hash)}</code></div>${copyButton('eip55Hash')}</div>
      <div class="address-output"><div><span class="mini-label">${activeNetwork.shortLabel} ADDRESS · EIP-55</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  }

  const recoveredEntropy = wallet.stage >= 5 ? mnemonicToEntropy(wallet.phrase, wordlist) : null;
  const entropyRoundTripMatches = recoveredEntropy && hex(recoveredEntropy) === hex(wallet.entropy);
  const backwardPanel = wallet.stage >= 5 && backwardOpen ? `
    <section class="backward-panel">
      <div class="backward-heading"><div><span class="eyebrow">LIVE REVERSE TRACE</span><h3>What can—and cannot—be recovered?</h3></div><span class="live-example">THIS SESSION · REAL VALUES</span></div>
      <p class="backward-intro">Read from your generated address back toward entropy. The forward outputs are visible above; these rows show what each output still tells you about its input.</p>
      <div class="carry-strip"><span><b>Carried forward</b> deterministic relationships, checksums, and the chosen derivation path</span><span><b>Changed at each step</b> representation, key material, and finally a shortened hash</span></div>
      <div class="reverse-list">
        <article class="reverse-row blocked"><div class="reverse-step">06</div><div class="reverse-content"><div class="reverse-title"><strong>Address ← public key</strong><span class="recovery-tag no">NOT REVERSIBLE</span></div><div class="reverse-live"><label>Live address</label><code>${wallet.address}</code></div><p>${activeNetwork.family === 'bitcoin' ? (activeNetwork.format === 'p2wpkh' ? 'Bitcoin hashes the compressed public key with HASH160 and encodes the witness program using Bech32; there is no inverse to recover the public key.' : activeNetwork.format === 'p2pkh' ? 'Bitcoin Legacy hashes the compressed public key with HASH160, then adds Base58Check version and checksum; this does not reveal the public key.' : activeNetwork.format === 'p2sh-p2wpkh' ? 'Nested SegWit hashes a redeem script containing the witness program with HASH160 and Base58Check; the address alone reveals neither the script nor public key.' : 'Taproot encodes a tweaked x-only output key; the address does not reveal the internal key or private scalar.') : activeNetwork.family === 'bnbBeacon' ? 'BNB Beacon hashes the compressed public key with HASH160 and encodes it with Bech32; there is no inverse to recover the key.' : activeNetwork.family === 'tron' ? 'TRON Keccak-hashes the public-key body, keeps 20 bytes, then adds a version and Base58Check checksum; this does not reveal the key.' : 'Keccak-256 hashes the public-key body and the address keeps only 20 digest bytes. There is no inverse formula to recover the public key from this value.'}</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">05</div><div class="reverse-content"><div class="reverse-title"><strong>Public key ← private key</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Live public key</label><code>${shortHex(wallet.publicKey, 18, 12)}</code></div><p>The public key is <code>Q = d × G</code> on secp256k1. Finding <code>d</code> from <code>Q</code> requires solving the elliptic-curve discrete-log problem.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">04</div><div class="reverse-content"><div class="reverse-title"><strong>Child key ← master node + path</strong><span class="recovery-tag no">PATH MATTERS</span></div><div class="reverse-live"><label>Path used</label><code>${activeNetwork.path}</code><label class="second-live-label">Live child key</label><code>${shortHex(wallet.account.privateKey, 18, 12)}</code></div><p>BIP-32 derives a child using HMAC-SHA512 and the selected path. The address does not encode that path. A child key alone lacks the parent chain code; hardened levels (${pathSegments.filter((segment) => segment.endsWith("'")).map((segment) => segment.replace("'", '′')).join(', ')}) also block deriving ancestors.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">03</div><div class="reverse-content"><div class="reverse-title"><strong>Master node ← BIP-39 seed</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Master private · IL</label><code>${shortHex(wallet.master.privateKey, 18, 12)}</code><label class="second-live-label">Master chain code · IR</label><code>${shortHex(wallet.master.chainCode, 18, 12)}</code></div><p>BIP-32 creates these with HMAC-SHA512 using the key <code>Bitcoin seed</code>. The master node is derived from the seed; it does not contain a reversible copy of it.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">02</div><div class="reverse-content"><div class="reverse-title"><strong>Seed ← mnemonic + passphrase</strong><span class="recovery-tag no">CANDIDATES ONLY</span></div><div class="reverse-live"><label>Live seed · abbreviated</label><code>${shortHex(wallet.seed, 20, 12)}</code><label class="second-live-label">Passphrase used</label><code>${passphrase ? 'non-empty · hidden' : 'empty'}</code></div><p>PBKDF2-HMAC-SHA512 produces a 512-bit seed. It is not an encrypted copy of the words. You can test a guessed phrase and passphrase by running forward and comparing, but cannot extract the original from the seed.</p></div></article>
        <article class="reverse-row reversible"><div class="reverse-step">01</div><div class="reverse-content"><div class="reverse-title"><strong>Mnemonic → entropy</strong><span class="recovery-tag yes">REVERSIBLE</span></div><div class="reverse-live"><label>Live phrase</label><code>${wallet.phrase}</code><label class="second-live-label">Recovered entropy · matches original: ${entropyRoundTripMatches ? 'YES' : 'NO'}</label><code>${spacedHex(recoveredEntropy)}</code></div><p>This is the exception: the 12 word indices encode the 128 entropy bits plus a 4-bit checksum. BIP-39 can decode the phrase back to the exact entropy and verify its checksum.</p></div></article>
      </div>
      <div class="takeaway"><strong>Why address → phrase search is not practical</strong><span>With no phrase words known, a search must try up to 2<sup>128</sup> valid mnemonics (and know the passphrase and derivation path), derive each address, then compare. This is not a useful workload for the $85 EC2 budget.</span></div>
    </section>` : '';
  const publicKeyInputEntered = activeNetwork.family === 'evm' && looksLikeEvmPublicKey(labAddressInput ?? '');
  const searchButtonLabel = discreteLogProgress ? 'Searching candidates…' : publicKeyInputEntered && !searchAddressFile?.addresses?.length
    ? 'Calculate full Keccak-256 from public key' : 'Search candidate range';
  const discreteLogLab = `
    <section class="backward-panel dlog-panel" id="search-lab">
      <div class="backward-heading"><div><span class="eyebrow">BOUNDED ADDRESS SEARCH · LOCAL ONLY</span><h3>Search ${activeNetwork.label}</h3></div><span class="live-example">INCLUSIVE RANGE · LOCAL WORKERS</span></div>
      <p class="backward-intro">Paste a valid address or load a .txt list of Ethereum addresses. Search checks the inclusive scalar range below; choose a small test range. If a candidate matches, other workers stop after their current small chunk. It runs in browser workers; the address and candidates are not sent to EC2.</p>
      <div class="dlog-address-control"><label for="lab-address">${activeNetwork.label} address or public key</label><input id="lab-address" type="text" spellcheck="false" autocomplete="off" placeholder="${addressPlaceholder()}" value="${escapeHtml(labAddressInput ?? wallet.address ?? '')}" ${discreteLogProgress ? 'disabled' : ''}><small>${addressInputHint()}</small>${labAddressInput?.trim() ? '<button class="reverse-toggle" id="export-public-address" type="button">Export public address</button>' : ''}</div>
      ${selectedNetworkId === 'ethereum' ? `
        <div class="search-file-row"><div class="search-file-copy"><strong>Search Ethereum address lists</strong><small>Upload one address per line for the scalar search, or address,transaction-hash pairs to extract public keys. Pair format: address,tx_hash.</small></div><label class="search-file-button ${discreteLogProgress ? 'is-disabled' : ''}" for="search-address-file" aria-disabled="${Boolean(discreteLogProgress)}">Choose file</label><input id="search-address-file" type="file" accept=".txt,text/plain,.csv,text/csv" hidden ${discreteLogProgress ? 'disabled' : ''}>${searchAddressFile ? `<span class="search-file-name">${escapeHtml(searchAddressFile.name)} · ${searchAddressFile.addresses?.length ?? 0} addresses${searchAddressFile.transactions?.length ? ` · ${searchAddressFile.transactions.length} txs` : ''}</span><button class="search-file-clear" id="clear-search-file" type="button" ${discreteLogProgress ? 'disabled' : ''}>Clear</button>` : ''}</div>
        ${searchAddressFile?.error ? `<p class="search-file-error" role="alert">${escapeHtml(searchAddressFile.error)}</p>` : ''}
        ${searchAddressFile?.addresses?.length ? `<ul class="search-target-preview">${searchAddressFile.addresses.map((address, index) => `<li><b>${index + 1}.</b> <code>${escapeHtml(address)}</code></li>`).join('')}</ul>` : ''}
        ${searchAddressFile?.transactions?.length ? `<div class="public-key-extract-panel"><label for="ethereum-rpc-endpoint">Ethereum JSON-RPC endpoint</label><input id="ethereum-rpc-endpoint" type="url" value="${escapeHtml(ethereumRpcEndpoint)}" spellcheck="false"><small>Extracts signer public keys from outgoing transactions. The transaction hashes are sent to this RPC provider; private keys are never requested.</small><button class="search-file-button" id="extract-public-keys" type="button">Extract public keys and download TXT</button><p id="public-key-extraction-status" role="status" aria-live="polite"></p></div>` : ''}
      ` : ''}
      <div class="candidate-range"><label>Lower scalar (inclusive)<input id="search-lower" type="text" inputmode="numeric" value="${escapeHtml(searchLower)}"></label><label>Upper scalar (inclusive)<input id="search-upper" type="text" inputmode="numeric" value="${escapeHtml(searchUpper)}"></label></div>
      <p class="step-explanation subtle">You can edit bounds during a run; changes apply to the next search. Current run bounds remain unchanged.</p>
      <div class="dlog-warning"><strong>Bounded test only—not wallet recovery.</strong> Only a match in the chosen interval can be found; a miss says nothing about other scalars. Even a small-looking range can take a long time. Pollard kangaroo requires a public point and a known interval; it cannot search an address hash. One million candidates per second is not guaranteed; the actual rate depends on the device.</div>
      <div class="dlog-actions"><button class="action-button dlog-button" id="run-dlog-lab" type="button" ${discreteLogProgress ? 'disabled' : ''}>${searchButtonLabel}<span aria-hidden="true">↗</span></button>${discreteLogProgress ? `<button class="dlog-stop-button" id="stop-search" type="button">${discreteLogProgress.stopping ? 'Stopping after current chunks…' : 'Stop search'}</button>` : ''}</div>
      ${discreteLogProgress ? `<div class="dlog-live-progress" role="status" aria-live="polite"><b>Checked ${discreteLogProgress.completed.toLocaleString()} / ${discreteLogProgress.trials.toLocaleString()} candidates</b><p>Running interval ${discreteLogProgress.startScalar.toLocaleString()}–${discreteLogProgress.endScalar.toLocaleString()}</p><div class="search-progress"><span style="width:${100 * Number(discreteLogProgress.completed) / Number(discreteLogProgress.trials)}%"></span></div><p>${discreteLogProgress.candidatesPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })} candidates/second · ${discreteLogProgress.workers} browser workers · ${discreteLogProgress.elapsedMs.toFixed(1)} ms elapsed · ${discreteLogProgress.candidatesPerSecond ? `about ${formatDuration(Number(discreteLogProgress.trials - discreteLogProgress.completed) * 1000 / discreteLogProgress.candidatesPerSecond)} remaining at this rate` : 'measuring speed'}.</p></div>` : searchResultMarkup(discreteLogResult, activeNetwork)}
      <p class="step-explanation subtle">Each worker starts with Q=dG, then advances with Q(d+1)=Q(d)+G and compares address payload bytes directly. Workers batch-normalize points to reduce field inversions, avoiding a fresh scalar multiplication and address encoding for every candidate. The operation stays on this device; it is not an EC2 background job.</p>
    </section>`;

  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#overview" aria-label="Seedlab home"><span class="brand-mark">S</span><span>SEEDLAB<span class="brand-sub">/ EXCHANGE LAB</span></span></a><nav class="exchange-nav" aria-label="Main navigation"><a class="active" href="#overview">Overview</a><a href="#setup-card">Wallet lab</a><a href="#derivation-pipeline">Derivation</a><a href="#kangaroo-demo">Kangaroo demo</a><a href="#public-key-search">Public-key search</a><a href="#search-lab">Address search</a></nav><div class="topbar-meta"><span class="live-dot"></span><span>LOCAL SESSION</span><span class="network-chip">${activeNetwork.shortLabel}</span></div></header>
    <main class="page-shell" id="overview">
      <div class="page-heading"><div><div class="eyebrow">WALLET ENGINE <span class="eyebrow-slash">/</span> DERIVATION & SEARCH</div><h1>Crypto Wallet Lab</h1><p>Explore address derivation, public-key recovery, and bounded-search algorithms in a trading-terminal style workspace.</p></div><div class="session-chip"><span class="session-dot"></span>${wallet.stage ? `DERIVATION ${String(Math.min(wallet.stage, 5)).padStart(2, '0')} / 05` : 'ENGINE READY'}</div></div>
      <div class="security-banner"><span class="alert-mark">!</span><p><strong>Public HTTP learning demo.</strong> The local derivation lab keeps secret values in this browser. The “Scan on server” upload sends your file to the server (S3 + Lambda) for scanning and is <strong>not</strong> stored permanently — only send test data, never real wallet secrets.</p></div>
      <div class="market-strip" aria-label="Workspace status"><div><span>ACTIVE NETWORK</span><b><i class="network-dot"></i>${activeNetwork.label}</b></div><div><span>CURVE</span><b>SECP256K1</b></div><div><span>KEY FLOW</span><b>BIP-39 <em>→</em> BIP-32</b></div><div><span>SEARCH ENGINE</span><b>LOCAL WORKERS · UP TO 8</b></div></div>
      <div class="layout-grid">
        <div class="lesson-column">
          <section class="setup-card" id="setup-card"><div class="setup-copy"><span class="eyebrow">START HERE</span><h2>Make a fresh demo wallet</h2><p>Uses browser cryptographic randomness. Nothing is saved or sent to EC2.</p></div><div class="setup-controls"><label for="network-select">Derive an address for</label><select id="network-select">${Object.entries(NETWORKS).map(([id, network]) => `<option value="${id}" ${selectedNetworkId === id ? 'selected' : ''}>${network.label}</option>`).join('')}</select><small class="network-note">Includes BTC Legacy, Nested SegWit, Native SegWit and Taproot; TRON; BNB Smart Chain (EVM) and BNB Beacon (BEP2).</small><label for="passphrase">Optional BIP-39 passphrase</label><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank for no passphrase" value="${passphrase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" ${wallet.stage ? 'disabled' : ''}><small>${wallet.stage ? 'Locked for this derivation; reset to change it.' : 'Case-sensitive. It creates a different wallet.'}</small><button class="action-button generate-button" id="generate">${wallet.stage ? 'Generate another demo wallet' : 'Generate demo wallet'}<span aria-hidden="true">↗</span></button></div></section>
          ${kangarooDemoMarkup()}
          ${pointSearchMarkup()}
          <div class="steps-heading" id="derivation-pipeline"><div><span class="eyebrow">THE PIPELINE</span><h2>Five steps, one address</h2></div><div class="steps-actions">${wallet.stage >= 5 ? `<button class="reverse-toggle" id="backward-toggle">${backwardOpen ? 'Hide backward trace' : 'Trace backward'}</button>` : ''}${wallet.stage ? '<button class="reset-button" id="reset">Reset session</button>' : ''}</div></div>
          ${stepCard({ number: '01', title: 'Entropy → mnemonic', caption: 'Create randomness and encode twelve words', step: 1, body: entropyBody, action: 'Generate 128-bit entropy & phrase' })}
          ${stepCard({ number: '02', title: 'Mnemonic → seed', caption: 'PBKDF2-HMAC-SHA512 · BIP-39', step: 2, body: seedBody, action: 'Derive 512-bit seed' })}
          ${stepCard({ number: '03', title: 'Seed → master node', caption: 'HMAC-SHA512 · BIP-32', step: 3, body: masterBody, action: 'Create BIP-32 master node' })}
          ${stepCard({ number: '04', title: `Master node → ${activeNetwork.label} keypair`, caption: `${activeNetwork.path.split('/')[1].replaceAll("'", '′')} path · secp256k1`, step: 4, body: accountBody, action: `Derive ${activeNetwork.label} account` })}
          ${stepCard({ number: '05', title: `${activeNetwork.label} public key → address`, caption: addressCaption(activeNetwork), step: 5, body: addressBody, action: `Compute ${activeNetwork.label} address` })}${wallet.stage >= 5 ? '<button class="reverse-toggle" id="export-seed-wallet" type="button">Export wallet details</button><p class="hash-footnote">Includes the address and BIP-39 recovery phrase. Anyone with the phrase can control the wallet; save it only somewhere secure.</p>' : ''}
          ${backwardPanel}
          ${discreteLogLab}
          ${scanCardMarkup()}
        </div>
        <aside class="side-rail">
          <section class="rail-card"><div class="rail-title"><span class="eyebrow">MAP</span><span class="rail-index">01—05</span></div><ol class="flow-list"><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>01</b><span>128-bit entropy</span></li><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>02</b><span>12 BIP-39 words</span></li><li class="${wallet.stage >= 2 ? 'visited' : ''}"><b>03</b><span>512-bit seed</span></li><li class="${wallet.stage >= 3 ? 'visited' : ''}"><b>04</b><span>BIP-32 master node</span></li><li class="${wallet.stage >= 4 ? 'visited' : ''}"><b>05</b><span>${activeNetwork.shortLabel} keypair</span></li><li class="${wallet.stage >= 5 ? 'visited current' : ''}"><b>↳</b><span>${activeNetwork.shortLabel} address</span></li></ol></section>
          <section class="rail-card path-card"><span class="eyebrow">${activeNetwork.shortLabel} PATH</span><code>${activeNetwork.path}</code><p>Switching networks selects a different derivation path or address encoding.</p></section>
          <section class="rail-card note-card"><span class="note-icon">i</span><div><strong>Keep the direction clear</strong><p>Each step derives new material from the prior value. The process does not provide a practical way to reverse a seed into its original phrase.</p></div></section>
          <div class="rail-foot">LOCAL COMPUTE <span>·</span> OPTIONAL RPC</div>
        </aside>
      </div>
      <footer class="page-footer"><span>SEEDLAB <span class="footer-muted">· INTERACTIVE CRYPTOGRAPHY PRIMER</span></span><span>TEST VALUES ONLY · NEVER FOR FUNDS</span></footer>
    </main>`;

  const passInput = document.querySelector('#passphrase');
  passInput?.addEventListener('input', (event) => { passphrase = event.target.value; });
  document.querySelector('#network-select')?.addEventListener('change', selectNetwork);
  document.querySelector('#generate')?.addEventListener('click', generateWallet);
  document.querySelector('#run-kangaroo-demo')?.addEventListener('click', runKangarooDemoFromUi);
  document.querySelector('#point-search-start')?.addEventListener('click', startPointSearch);
  document.querySelector('#run-gpu-benchmark')?.addEventListener('click', startGpuBenchmark);
  document.querySelector('#stop-gpu-benchmark')?.addEventListener('click', (event) => { event.target.disabled = true; event.target.textContent = 'Stopping…'; gpuBenchmarkWorker?.postMessage({ type: 'cancel' }); });
  document.querySelector('#gpu-benchmark-preference')?.addEventListener('change', (event) => { gpuBenchmark.preference = event.target.value; });
  document.querySelector('#copy-gpu-benchmark')?.addEventListener('click', async (event) => {
    try { await copyToClipboard(gpuBenchmarkReport(gpuBenchmark.result)); event.target.textContent = 'Copied'; }
    catch { event.target.textContent = 'Copy unavailable'; }
  });
  document.querySelector('#point-retry-cpu')?.addEventListener('click', () => { pointSearch.backend = 'cpu'; startPointSearch(); });
  document.querySelector('#point-search-stop')?.addEventListener('click', (event) => { event.target.disabled = true; event.target.textContent = 'Stopping…'; pointSearchPool?.cancel(); });
  document.querySelector('#point-search-backend')?.addEventListener('change', (event) => { pointSearch.backend = event.target.value; });
  document.querySelector('#point-search-workers')?.addEventListener('change', (event) => { pointSearch.workers = event.target.value; });
  document.querySelector('#point-search-lower')?.addEventListener('input', (event) => { pointSearch.lower = event.target.value; updateRangePlanner(); });
  document.querySelector('#point-search-upper')?.addEventListener('input', (event) => { pointSearch.upper = event.target.value; updateRangePlanner(); });
  document.querySelector('#planner-bits')?.addEventListener('input', (event) => { rangePlanner.bits = event.target.value; rangePlanner.error = ''; updateRangePlanner(); });
  document.querySelector('#planner-targets')?.addEventListener('input', (event) => { rangePlanner.targets = event.target.value; updateRangePlanner(); });
  document.querySelector('#planner-rate')?.addEventListener('input', (event) => { rangePlanner.rate = event.target.value; updateRangePlanner(); });
  document.querySelector('#planner-apply-bits')?.addEventListener('click', () => {
    try {
      const range = rangeForBitLength(rangePlanner.bits.trim());
      pointSearch.lower = range.start.toString(); pointSearch.upper = range.end.toString();
      document.querySelector('#point-search-lower').value = pointSearch.lower;
      document.querySelector('#point-search-upper').value = pointSearch.upper;
      rangePlanner.error = '';
    } catch (error) { rangePlanner.error = error.message; }
    updateRangePlanner();
  });
  document.querySelector('#point-search-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    pointSearch.text = ''; pointSearch.result = null; pointSearch.error = ''; pointSearch.fileName = file.name;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds the 5 MB limit.');
      pointSearch.text = await file.text();
    } catch (error) { pointSearch.error = error?.message ?? String(error); }
    render();
  });
  document.querySelector('#export-seed-wallet')?.addEventListener('click', () => exportTextFile('wallet-export.txt', `Wallet address: ${wallet.address}\nNetwork: ${activeNetwork.label}\nBIP-39 recovery phrase: ${wallet.phrase}\n\nSECURITY: This phrase controls the wallet. Keep it private.`));
  document.querySelector('#export-public-address')?.addEventListener('click', () => exportTextFile('public-address.txt', `Public address: ${(labAddressInput ?? '').trim()}\nNetwork: ${activeNetwork.label}\n`));
  document.querySelector('#reset')?.addEventListener('click', resetWallet);
  document.querySelector('#backward-toggle')?.addEventListener('click', () => {
    backwardOpen = !backwardOpen;
    render();
  });
  document.querySelector('#ethereum-rpc-endpoint')?.addEventListener('input', (event) => { ethereumRpcEndpoint = event.target.value; });
  document.querySelector('#extract-public-keys')?.addEventListener('click', extractUploadedPublicKeys);
  document.querySelector('#search-address-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsedFile = parseAddressFile(await file.text(), selectedNetworkId);
      invalidateSearch();
      searchAddressFile = { name: file.name, ...parsedFile, error: null };
      render();
    } catch (error) {
      invalidateSearch();
      searchAddressFile = { name: file.name, addresses: [], error: error.message };
      render();
    }
  });
  document.querySelector('#clear-search-file')?.addEventListener('click', () => {
    invalidateSearch();
    searchAddressFile = null;
    render();
  });
  document.querySelector('#search-lower')?.addEventListener('input', (event) => { searchLower = event.target.value; });
  document.querySelector('#search-upper')?.addEventListener('input', (event) => { searchUpper = event.target.value; });
  document.querySelector('#run-dlog-lab')?.addEventListener('click', runDiscreteLogLab);
  document.querySelector('#stop-search')?.addEventListener('click', requestSearchStop);
  document.querySelector('#lab-address')?.addEventListener('input', (event) => {
    labAddressInput = event.target.value;
    if (discreteLogResult && labAddressInput.trim() !== discreteLogResult.addressInput) {
      discreteLogResult = null;
      document.querySelector('.dlog-results')?.remove();
      document.querySelector('.dlog-warning.result-error')?.remove();
    }
    const button = document.querySelector('#run-dlog-lab');
    if (button && !discreteLogProgress) {
      button.disabled = false;
      button.innerHTML = `${activeNetwork.family === 'evm' && looksLikeEvmPublicKey(labAddressInput) ? 'Calculate full Keccak-256 from public key' : 'Search candidate range'}<span aria-hidden="true">↗</span>`;
    }
  });
  document.querySelectorAll('[data-run-step]').forEach((button) => button.addEventListener('click', () => runStep(Number(button.dataset.runStep))));
  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await copyToClipboard(copyValue(button.dataset.copy));
      copied.add(button.dataset.copy);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy unavailable';
    }
  }));
  document.querySelector('#scan-file')?.addEventListener('change', (event) => {
    pendingFile = event.target.files && event.target.files[0];
    render();
  });
  document.querySelector('#scan-start')?.addEventListener('click', startScan);
  setScanStatus();
  renderScanResults();
  restoreScalarFocus(document, scalarFocus);
}

function selectNetwork(event) {
  invalidateSearch();
  searchAddressFile = null;
  selectedNetworkId = event.target.value;
  discreteLogResult = null;
  labAddressInput = null;
  copied = new Set();
  if (wallet.stage >= 4) {
    deriveAccountForNetwork();
    if (wallet.stage >= 5) deriveNetworkAddress();
  }
  render();
}

function generateWallet() {
  invalidateSearch();
  try {
    const passInput = document.querySelector('#passphrase');
    if (passInput) passphrase = passInput.value;
    const entropy = new Uint8Array(16);
    globalThis.crypto.getRandomValues(entropy);
    wipeWalletSecrets();
    wallet = freshWallet();
    backwardOpen = false;
    discreteLogResult = null;
    labAddressInput = null;
    wallet.entropy = entropy;
    wallet.entropyHash = sha256(entropy);
    wallet.entropyChecksum = binary(wallet.entropyHash).slice(0, 4);
    const mnemonicBits = binary(entropy) + wallet.entropyChecksum;
    wallet.wordChunks = Array.from({ length: 12 }, (_, index) => mnemonicBits.slice(index * 11, (index + 1) * 11));
    wallet.phrase = entropyToMnemonic(entropy, wordlist);
    wallet.stage = 1;
    copied = new Set();
    render();
  } catch {
    alert('Secure browser randomness is unavailable. Use HTTPS or localhost for browser cryptography.');
  }
}

function runStep(step) {
  try {
    if (step === 2 && wallet.stage === 1) {
      const normalizedPassphrase = passphrase.normalize('NFKD');
      wallet.bip39Salt = new TextEncoder().encode(`mnemonic${normalizedPassphrase}`);
      wallet.seed = mnemonicToSeedSync(wallet.phrase, passphrase);
    } else if (step === 3 && wallet.stage === 2) {
      wallet.master = HDKey.fromMasterSeed(wallet.seed);
      wallet.masterHmacOutput = new Uint8Array([...wallet.master.privateKey, ...wallet.master.chainCode]);
    } else if (step === 4 && wallet.stage === 3) {
      deriveAccountForNetwork();
    } else if (step === 5 && wallet.stage === 4) {
      deriveNetworkAddress();
    }
    wallet.stage = step;
    copied = new Set();
    render();
  } catch (error) {
    console.error(error);
    alert('That derivation step failed. Reset and try again in a modern browser.');
  }
}

function deriveAccountForNetwork() {
  wallet.pathNodes.forEach((entry) => entry.node?.wipePrivateData());
  wallet.account?.wipePrivateData();
  const segments = selectedNetwork().path.slice(2).split('/');
  wallet.pathNodes = segments.map((segment, index) => {
    const fullPath = `m/${segments.slice(0, index + 1).join('/')}`;
    const node = wallet.master.derive(fullPath);
    const value = Number(segment.replace("'", ''));
    const hardened = segment.endsWith("'");
    return { segment, fullPath, hardened, childIndex: value + (hardened ? 0x80000000 : 0), node };
  });
  wallet.account = wallet.pathNodes.at(-1).node;
  wallet.publicKey = secp256k1.getPublicKey(wallet.account.privateKey, false);
  wallet.compressedPublicKey = wallet.account.publicKey;
}

function calculateAddressData(privateKey, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const compressedPublicKey = secp256k1.getPublicKey(privateKey, true);
  if (network.family === 'bitcoin') {
    if (network.format === 'p2tr') {
      const taproot = taprootDetails(privateKey);
      return { publicKey, compressedPublicKey, address: taproot.address, addressBytes: taproot.outputX, taprootData: taproot };
    }
    const btcSha256 = sha256(compressedPublicKey);
    const btcHash160 = ripemd160(btcSha256);
    if (network.format === 'p2wpkh') {
      return { publicKey, compressedPublicKey, btcSha256, btcHash160, addressBytes: btcHash160, address: bech32.encode('bc', [0, ...bech32.toWords(btcHash160)]) };
    }
    if (network.format === 'p2pkh') {
      const checked = base58Check(new Uint8Array([0x00, ...btcHash160]));
      return { publicKey, compressedPublicKey, btcSha256, btcHash160, btcPayload: checked.payload, btcChecksum: checked.checksum, addressBytes: btcHash160, address: checked.address };
    }
    const btcRedeemScript = new Uint8Array([0x00, 0x14, ...btcHash160]);
    const btcScriptHash = hash160(btcRedeemScript);
    const checked = base58Check(new Uint8Array([0x05, ...btcScriptHash]));
    return { publicKey, compressedPublicKey, btcSha256, btcHash160, btcRedeemScript, btcScriptHash, btcPayload: checked.payload, btcChecksum: checked.checksum, addressBytes: btcScriptHash, address: checked.address };
  }
  if (network.family === 'bnbBeacon') {
    const btcHash160 = hash160(compressedPublicKey);
    return { publicKey, compressedPublicKey, btcHash160, addressBytes: btcHash160, address: bech32.encode('bnb', bech32.toWords(btcHash160)) };
  }
  const keccakHash = keccak_256(publicKey.slice(1));
  const addressBytes = keccakHash.slice(12);
  if (network.family === 'tron') {
    const tronPayload = new Uint8Array([0x41, ...addressBytes]);
    const tronShaFirst = sha256(tronPayload);
    const tronShaSecond = sha256(tronShaFirst);
    const tronChecksum = tronShaSecond.slice(0, 4);
    const tronBase58Bytes = concatBytes(tronPayload, tronChecksum);
    return { publicKey, compressedPublicKey, keccakHash, addressBytes, tronPayload, tronShaFirst, tronShaSecond, tronChecksum, tronBase58Bytes, address: base58.encode(tronBase58Bytes) };
  }
  const lowerAddress = hex(addressBytes);
  const eip55Hash = keccak_256(new TextEncoder().encode(lowerAddress));
  return { publicKey, compressedPublicKey, keccakHash, addressBytes, eip55Hash, address: checksumAddress(lowerAddress, eip55Hash) };
}

function parseBase58Check(input, version) {
  try {
    const decoded = base58.decode(input);
    if (decoded.length !== 25) return { valid: false, reason: 'Base58Check address must decode to 25 bytes.' };
    const payload = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const expected = sha256(sha256(payload)).slice(0, 4);
    if (payload[0] !== version || hex(checksum) !== hex(expected)) return { valid: false, reason: 'Address version or Base58Check checksum is invalid for this profile.' };
    return { valid: true, display: input, normalized: input, bytes: payload.slice(1), payload, checksum };
  } catch {
    return { valid: false, reason: 'Address is not valid Base58Check.' };
  }
}

function parseEvmPublicKey(input) {
  const key = input.trim().replace(/\s+/g, '').replace(/^0x/i, '');
  if (!looksLikeEvmPublicKey(key)) return null;
  try {
    let bytes = Uint8Array.from(key.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
    if (bytes.length === 64) bytes = new Uint8Array([0x04, ...bytes]);
    const publicKey = secp256k1.Point.fromBytes(bytes).toBytes(false);
    const keccakHash = keccak_256(publicKey.slice(1));
    const addressBytes = keccakHash.slice(12);
    const lowerAddress = hex(addressBytes);
    const checksumHash = keccak_256(new TextEncoder().encode(lowerAddress));
    return {
      valid: true,
      inputKind: 'publicKey',
      publicKey,
      keyKeccakHash: keccakHash,
      display: checksumAddress(lowerAddress, checksumHash),
      normalized: `0x${lowerAddress}`,
      bytes: addressBytes,
      checksumHash,
    };
  } catch {
    return { valid: false, reason: 'Public key is not a valid secp256k1 point. Paste a 33-byte compressed or 64/65-byte uncompressed public key.' };
  }
}

function parseNetworkAddress(input, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  if (network.family === 'evm') {
    const publicKeyInput = parseEvmPublicKey(input);
    if (publicKeyInput) return publicKeyInput;
    if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return { valid: false, reason: 'Enter a 0x-prefixed 20-byte address, or paste a valid compressed/uncompressed secp256k1 public key.' };
    const body = input.slice(2);
    const lower = body.toLowerCase();
    const mixed = body !== lower && body !== body.toUpperCase();
    const checksummed = checksumAddress(lower);
    if (mixed && checksummed !== input) return { valid: false, reason: 'Mixed-case address failed its EIP-55 checksum.' };
    return { valid: true, display: checksummed, normalized: `0x${lower}`, bytes: Uint8Array.from(lower.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)), checksumHash: keccak_256(new TextEncoder().encode(lower)) };
  }
  if (network.family === 'tron') {
    const result = parseBase58Check(input, 0x41);
    return result.valid ? { ...result, payload: result.payload } : { valid: false, reason: 'Enter a valid TRON mainnet Base58Check address (version 0x41, usually starts with T).' };
  }
  if (network.family === 'bnbBeacon') {
    try {
      const decoded = bech32.decode(input);
      const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
      if (decoded.prefix !== 'bnb' || bytes.length !== 20) return { valid: false, reason: 'Enter a BNB Beacon Chain Bech32 address (bnb prefix, 20-byte payload).' };
      return { valid: true, display: bech32.encode('bnb', bech32.toWords(bytes)), normalized: input.toLowerCase(), bytes };
    } catch {
      return { valid: false, reason: 'Enter a valid BNB Beacon Chain Bech32 address beginning with bnb1.' };
    }
  }
  if (network.format === 'p2pkh') return parseBase58Check(input, 0x00);
  if (network.format === 'p2sh-p2wpkh') return parseBase58Check(input, 0x05);
  try {
    if (network.format === 'p2tr') {
      const decoded = bech32m.decode(input);
      const program = Uint8Array.from(bech32m.fromWords(decoded.words.slice(1)));
      if (decoded.prefix !== 'bc' || decoded.words[0] !== 1 || program.length !== 32) return { valid: false, reason: 'Enter a Bitcoin mainnet Taproot P2TR address (bc1p…, witness v1, 32-byte output key).' };
      return { valid: true, display: bech32m.encode('bc', [1, ...bech32m.toWords(program)]), normalized: input.toLowerCase(), bytes: program };
    }
    const decoded = bech32.decode(input);
    const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
    if (decoded.prefix !== 'bc' || decoded.words[0] !== 0 || program.length !== 20) return { valid: false, reason: 'Enter a Bitcoin mainnet native-SegWit P2WPKH address (bc1q…, witness v0, 20-byte program).' };
    return { valid: true, display: bech32.encode('bc', [0, ...bech32.toWords(program)]), normalized: input.toLowerCase(), bytes: program };
  } catch {
    return { valid: false, reason: network.format === 'p2tr' ? 'Enter a valid Bitcoin mainnet Bech32m Taproot address (bc1p…).': 'Enter a valid Bitcoin mainnet Bech32 P2WPKH address (bc1q…).' };
  }
}

function wipeTaprootData(data = wallet.taprootData) {
  data?.internalPrivateKey?.fill(0);
  data?.outputPrivateKey?.fill(0);
}

function deriveNetworkAddress() {
  wipeTaprootData();
  const data = calculateAddressData(wallet.account.privateKey);
  wallet.keccakHash = data.keccakHash ?? null;
  wallet.addressBytes = data.addressBytes;
  wallet.eip55Hash = data.eip55Hash ?? null;
  wallet.tronPayload = data.tronPayload ?? null;
  wallet.tronShaFirst = data.tronShaFirst ?? null;
  wallet.tronShaSecond = data.tronShaSecond ?? null;
  wallet.tronChecksum = data.tronChecksum ?? null;
  wallet.tronBase58Bytes = data.tronBase58Bytes ?? null;
  wallet.btcHash160 = data.btcHash160 ?? null;
  wallet.btcSha256 = data.btcSha256 ?? null;
  wallet.btcRedeemScript = data.btcRedeemScript ?? null;
  wallet.btcScriptHash = data.btcScriptHash ?? null;
  wallet.btcPayload = data.btcPayload ?? null;
  wallet.btcChecksum = data.btcChecksum ?? null;
  wallet.taprootData = data.taprootData ?? null;
  wallet.address = data.address;
}

function parseAddressFile(contents, networkId) {
  const lines = contents.split(/\r?\n/);
  const tokens = [];
  const transactions = [];
  const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(value);
  const isTransactionHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(value);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim().replace(/^\uFEFF/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^address[\s,;]+(?:tx_?hash|transaction_?hash)$/i.test(trimmed)) continue;

    const columns = trimmed.split(/[,;\t]+/).map((value) => value.trim()).filter(Boolean);
    if (columns.length === 2 && isAddress(columns[0]) && isTransactionHash(columns[1])) {
      tokens.push(columns[0]);
      transactions.push({ address: columns[0], txHash: columns[1] });
      continue;
    }

    const addressTokens = trimmed.split(/[\s,;]+/).filter(Boolean);
    if (!addressTokens.length || addressTokens.some((token) => !isAddress(token))) {
      throw new Error(`Line ${index + 1} must contain Ethereum addresses, or an address and transaction hash separated by a comma.`);
    }
    tokens.push(...addressTokens);
  }

  if (!tokens.length) throw new Error('The text file contains no Ethereum addresses.');
  const unique = new Map();
  for (const token of tokens) {
    const parsed = parseNetworkAddress(token, networkId);
    if (!parsed.valid) throw new Error(`Invalid address in file: ${parsed.reason}`);
    unique.set(parsed.normalized.toLowerCase(), parsed.display);
  }
  return { addresses: [...unique.values()], transactions };
}

async function fetchEthereumTransaction(rpcUrl, txHash, requestId) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'eth_getTransactionByHash', params: [txHash] }),
  });
  if (!response.ok) throw new Error(`RPC request failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Ethereum RPC returned an error.');
  if (!payload.result) throw new Error('Transaction was not found by the RPC provider.');
  return payload.result;
}

async function extractUploadedPublicKeys() {
  const entries = searchAddressFile?.transactions ?? [];
  const button = document.querySelector('#extract-public-keys');
  const endpointInput = document.querySelector('#ethereum-rpc-endpoint');
  const status = document.querySelector('#public-key-extraction-status');
  if (!entries.length || !button || !endpointInput || !status) return;

  const rpcUrl = endpointInput.value.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(rpcUrl);
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname))) {
      throw new Error('Use an HTTPS RPC endpoint (HTTP is allowed only for localhost).');
    }
  } catch (error) {
    status.textContent = error.message || 'Enter a valid Ethereum JSON-RPC URL.';
    return;
  }

  ethereumRpcEndpoint = rpcUrl;
  button.disabled = true;
  endpointInput.disabled = true;
  status.textContent = `Fetching ${entries.length} transactions…`;
  const results = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;
  const processNext = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      try {
        const transaction = await fetchEthereumTransaction(rpcUrl, entry.txHash, index + 1);
        if (transaction.hash?.toLowerCase() !== entry.txHash.toLowerCase()) throw new Error('RPC returned a different transaction hash.');
        if (transaction.from?.toLowerCase() !== entry.address.toLowerCase()) throw new Error('This transaction was not sent by the listed address. Use an outgoing transaction from that account.');
        const recovered = recoverEthereumTransactionPublicKey(transaction);
        if (recovered.address.toLowerCase() !== entry.address.toLowerCase()) throw new Error('Recovered signer address does not match the listed address.');
        results[index] = { ...entry, publicKey: recovered.publicKey, status: 'ok' };
      } catch (error) {
        results[index] = { ...entry, publicKey: '', status: (error?.message ?? String(error)).replace(/[\t\r\n]+/g, ' ') };
      }
      completed += 1;
      status.textContent = `Processed ${completed} of ${entries.length} transactions…`;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, processNext));
    const output = [
      'address\ttransaction_hash\tpublic_key_uncompressed\tstatus',
      ...results.map((row) => `${row.address}\t${row.txHash}\t${row.publicKey}\t${row.status}`),
    ].join('\n');
    exportTextFile('ethereum-public-keys.txt', `${output}\n`);
    const succeeded = results.filter((row) => row.status === 'ok').length;
    status.textContent = `Downloaded public-key results: ${succeeded} extracted, ${entries.length - succeeded} failed. Public keys are not private keys.`;
  } finally {
    button.disabled = false;
    endpointInput.disabled = false;
  }
}

function invalidateSearch() {
  searchRunId += 1;
  if (searchRenderTimer) clearTimeout(searchRenderTimer);
  searchRenderTimer = null;
  activeSearch?.workers.forEach((worker) => worker.terminate());
  activeSearch = null;
  discreteLogProgress = null;
  discreteLogResult = null;
}

function requestSearchStop() {
  if (!activeSearch || activeSearch.cancelRequested) return;
  activeSearch.manualStop = true;
  activeSearch.cancelRequested = true;
  activeSearch.workers.forEach((worker) => worker.postMessage({ type: 'cancel' }));
  discreteLogProgress = { ...discreteLogProgress, stopping: true };
  render();
}

function finishSearch(search, status, match = null, message = '') {
  if (activeSearch !== search) return;
  if (searchRenderTimer) clearTimeout(searchRenderTimer);
  searchRenderTimer = null;
  const totalTested = [...search.progressByWorker.values()].reduce((sum, count) => sum + count, 0n);
  const elapsedMs = Math.max(performance.now() - search.startedAt, 0.01);
  const candidatesPerSecond = Number(totalTested) * 1000 / elapsedMs;
  search.workers.forEach((worker) => worker.terminate());
  activeSearch = null;
  discreteLogProgress = null;
  discreteLogResult = {
    status, addressInput: search.addressInput, networkId: search.networkId, parsed: search.parsed,
    startScalar: search.range.start, endScalar: search.range.end, rangeCount: search.range.count,
    trials: totalTested, totalTested, elapsedMs, candidatesPerSecond,
    foundScalar: match?.scalar ?? null, foundPublicKey: match?.publicKey ?? null,
    foundAddress: match ? search.targets[match.targetIndex]?.display ?? '' : '',
    matchTargetIndex: match?.targetIndex ?? -1, targets: search.targets, workers: search.workers.length, message,
  };
  render();
}

async function runDiscreteLogLab() {
  invalidateSearch();
  const addressInput = document.querySelector('#lab-address')?.value.trim() ?? '';
  labAddressInput = addressInput;
  if (selectedNetworkId === 'ethereum' && searchAddressFile?.error) {
    discreteLogResult = { status: 'invalid', addressInput, reason: 'The selected address file must be corrected or cleared before searching.' };
    render();
    return;
  }
  let targets;
  if (selectedNetworkId === 'ethereum' && searchAddressFile?.addresses?.length) {
    targets = searchAddressFile.addresses.map((address) => parseNetworkAddress(address, selectedNetworkId));
  } else {
    const parsed = parseNetworkAddress(addressInput);
    if (!parsed.valid) {
      discreteLogResult = { status: 'invalid', addressInput, reason: parsed.reason, networkId: selectedNetworkId };
      render();
      return;
    }
    if (parsed.inputKind === 'publicKey') {
      discreteLogResult = { status: 'publicKey', addressInput, networkId: selectedNetworkId, parsed };
      render();
      return;
    }
    targets = [parsed];
  }
  const invalidTarget = targets.find((target) => !target.valid);
  if (invalidTarget) {
    discreteLogResult = { status: 'invalid', addressInput, reason: invalidTarget.reason, networkId: selectedNetworkId };
    render();
    return;
  }
  const parsed = targets[0];

  let range;
  try {
    range = parseSearchRange(searchLower.trim(), searchUpper.trim());
  } catch (error) {
    discreteLogResult = { status: 'invalid', addressInput, reason: error.message };
    render();
    return;
  }
  const partitions = partitionSearchRange(range.start, range.end, Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2)));
  const workerCount = partitions.length;
  const runId = ++searchRunId;
  const search = {
    runId, networkId: selectedNetworkId, addressInput, parsed, targets, range,
    workers: [], progressByWorker: new Map(), finishedWorkers: new Set(),
    foundMatch: null, cancelRequested: false, manualStop: false, startedAt: performance.now(),
  };
  activeSearch = search;
  discreteLogProgress = { completed: 0n, trials: range.count, startScalar: range.start, endScalar: range.end, elapsedMs: 0, candidatesPerSecond: 0, workers: workerCount };
  discreteLogResult = null;
  render();

  try {
    for (let workerId = 0; workerId < workerCount; workerId += 1) {
      const { start, end } = partitions[workerId];
      const worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
      search.workers.push(worker);
      search.progressByWorker.set(workerId, 0n);
      worker.onmessage = ({ data }) => {
        if (activeSearch !== search || search.runId !== runId) return;
        if (data.type === 'error') {
          finishSearch(search, 'error', null, data.message);
          return;
        }
        search.progressByWorker.set(data.workerId, data.tested);
        if (data.type === 'match') {
          search.finishedWorkers.add(data.workerId);
          if (!search.foundMatch) {
            search.foundMatch = data;
            search.cancelRequested = true;
            search.workers.forEach((other, index) => {
              if (index !== data.workerId) other.postMessage({ type: 'cancel' });
            });
          }
        } else if (data.type === 'done' || data.type === 'cancelled') {
          search.finishedWorkers.add(data.workerId);
        }

        const completed = [...search.progressByWorker.values()].reduce((sum, count) => sum + count, 0n);
        const elapsedMs = Math.max(performance.now() - search.startedAt, 0.01);
        discreteLogProgress = { completed, trials: range.count, startScalar: range.start, endScalar: range.end, elapsedMs, candidatesPerSecond: Number(completed) * 1000 / elapsedMs, workers: workerCount, stopping: search.cancelRequested };
        if (search.finishedWorkers.size === workerCount) {
          if (search.foundMatch) finishSearch(search, 'valid', search.foundMatch);
          else if (search.manualStop) finishSearch(search, 'cancelled');
          else finishSearch(search, 'valid');
          return;
        }
        if (!searchRenderTimer) {
          searchRenderTimer = setTimeout(() => {
            searchRenderTimer = null;
            if (activeSearch === search) render();
          }, 150);
        }
      };
      worker.onerror = (error) => finishSearch(search, 'error', null, error.message || 'A search worker failed.');
      worker.postMessage({ workerId, networkId: search.networkId, targetBytesList: targets.map((target) => target.bytes), start, end, chunkSize: SEARCH_WORKER_CHUNK });
    }
  } catch (error) {
    finishSearch(search, 'error', null, error?.message ?? String(error));
  }
}

function wipeWalletSecrets() {
  wipeTaprootData();
  wallet.entropy?.fill(0);
  wallet.bip39Salt?.fill(0);
  wallet.seed?.fill(0);
  wallet.masterHmacOutput?.fill(0);
  wallet.master?.wipePrivateData();
  wallet.pathNodes.forEach((entry) => entry.node?.wipePrivateData());
  wallet.account?.wipePrivateData();
}

function resetWallet() {
  invalidateSearch();
  searchAddressFile = null;
  wipeWalletSecrets();
  wallet = freshWallet();
  passphrase = '';
  backwardOpen = false;
  discreteLogResult = null;
  labAddressInput = null;
  copied = new Set();
  render();
}

render();
