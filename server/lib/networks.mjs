// Node port of the wallet derivation used in the browser app.
// Reuses the same audited libraries so server-side results match the UI exactly.
import { HDKey } from '@scure/bip32';
import { base58, bech32, bech32m } from '@scure/base';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const NETWORKS = {
  ethereum: { label: 'Ethereum', shortLabel: 'ETH', family: 'evm', path: "m/44'/60'/0'/0/0" },
  bitcoin: { label: 'Bitcoin · Native SegWit', shortLabel: 'BTC P2WPKH', family: 'bitcoin', format: 'p2wpkh', path: "m/84'/0'/0'/0/0" },
  bitcoinLegacy: { label: 'Bitcoin · Legacy', shortLabel: 'BTC Legacy', family: 'bitcoin', format: 'p2pkh', path: "m/44'/0'/0'/0/0" },
  bitcoinNested: { label: 'Bitcoin · Nested SegWit', shortLabel: 'BTC Nested', family: 'bitcoin', format: 'p2sh-p2wpkh', path: "m/49'/0'/0'/0/0" },
  bitcoinTaproot: { label: 'Bitcoin · Taproot', shortLabel: 'BTC Taproot', family: 'bitcoin', format: 'p2tr', path: "m/86'/0'/0'/0/0" },
  tron: { label: 'TRON', shortLabel: 'TRX', family: 'tron', path: "m/44'/195'/0'/0/0" },
  bnb: { label: 'BNB Smart Chain', shortLabel: 'BNB Smart Chain', family: 'evm', path: "m/44'/60'/0'/0/0" },
  bnbBeacon: { label: 'BNB Beacon Chain · Legacy', shortLabel: 'BNB Beacon', family: 'bnbBeacon', path: "m/44'/714'/0'/0/0" },
};

export const NETWORK_IDS = Object.keys(NETWORKS);

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
  return BigInt(`0x${bytesToHex(bytes)}`);
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

function checksumAddress(lowerHex, checksumDigest) {
  const lower = lowerHex.toLowerCase();
  const hash = bytesToHex(checksumDigest ?? keccak_256(new TextEncoder().encode(lower)));
  const checksummed = Array.from(lower, (character, index) => {
    if (/[a-f]/.test(character) && parseInt(hash[index], 16) >= 8) return character.toUpperCase();
    return character;
  }).join('');
  return `0x${checksummed}`;
}

// Derive all network addresses from a 32-byte private key (the account private key).
export function calculateAddressData(privateKey, networkId) {
  const network = NETWORKS[networkId];
  const publicKey = Buffer.from(secp256k1.getPublicKey(privateKey, false));
  const compressedPublicKey = Buffer.from(secp256k1.getPublicKey(privateKey, true));
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
  const lowerAddress = bytesToHex(addressBytes);
  const eip55Hash = keccak_256(new TextEncoder().encode(lowerAddress));
  return { publicKey, compressedPublicKey, keccakHash, addressBytes, eip55Hash, address: checksumAddress(lowerAddress, eip55Hash) };
}

// Derive the account private key for a network from a BIP-39 seed.
// Mirrors the browser app: HDKey.fromMasterSeed(seed).derive(fullPath).
export function deriveAccountPrivateKey(seed, networkId) {
  const network = NETWORKS[networkId];
  const master = HDKey.fromMasterSeed(seed);
  return master.derive(network.path).privateKey;
}

// Classify a single input line.
export function classifyInput(raw) {
  const text = String(raw).trim();
  if (!text || text.startsWith('#')) return { kind: 'blank' };

  // BIP-39 mnemonic
  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 12 && wordCount % 3 === 0 && validateMnemonic(text, wordlist)) {
    return { kind: 'mnemonic', value: text };
  }

  // Hex private key (32 bytes, with or without 0x)
  const hex = text.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return { kind: 'privateKey', value: hex };
  }

  // Possibly an address (we just echo it; it is not a secret we can derive from)
  return { kind: 'maybeAddress', value: text };
}

// Full derivation result for one input across all networks.
export function deriveSecret(input) {
  const { kind, value } = input;
  if (kind === 'mnemonic') {
    const seed = mnemonicToSeedSync(value, '');
    const addresses = {};
    const publicKeys = {};
    for (const id of NETWORK_IDS) {
      const privateKey = deriveAccountPrivateKey(seed, id);
      const data = calculateAddressData(privateKey, id);
      addresses[id] = data.address;
      publicKeys[id] = `0x${bytesToHex(data.compressedPublicKey)}`;
    }
    return { kind, value, valid: true, addresses, publicKeys, seed: bytesToHex(seed) };
  }
  if (kind === 'privateKey') {
    const privateKey = Uint8Array.from(value.replace(/^0x/i, '').match(/.{2}/g), (b) => Number.parseInt(b, 16));
    const addresses = {};
    const publicKeys = {};
    for (const id of NETWORK_IDS) {
      const data = calculateAddressData(privateKey, id);
      addresses[id] = data.address;
      publicKeys[id] = `0x${bytesToHex(data.compressedPublicKey)}`;
    }
    return { kind, value, valid: true, addresses, publicKeys };
  }
  if (kind === 'maybeAddress') {
    return { kind, value, valid: false, reason: 'Not a recognized mnemonic or private key; looks like an address (cannot derive secrets from an address).' };
  }
  return { kind: 'unknown', value: input.value ?? '', valid: false, reason: 'Unrecognized input.' };
}
