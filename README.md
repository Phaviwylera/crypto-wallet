# Seedlab — an interactive wallet primer

A browser-based, step-by-step crypto wallet learning demo. It generates BIP-39 entropy and a 12-word phrase, derives the 512-bit seed and BIP-32 keys, then shows address-construction traces for Ethereum, Bitcoin, TRON, and BNB profiles. Derivations and the bounded address search run locally in the browser; the full 10-million-scalar search uses a capped Web Worker pool.

## Run locally

```sh
npm ci
npm run dev
```

Open the URL Vite prints (localhost is a secure context for browser cryptography). Build with `npm run build`.

## Address profiles

| Profile | Derivation path | Address construction |
| --- | --- | --- |
| Ethereum | `m/44'/60'/0'/0/0` | secp256k1, legacy Keccak-256, last 20 bytes, EIP-55 |
| BNB Smart Chain | `m/44'/60'/0'/0/0` | Same EVM format and address as Ethereum for the same key; select the chain separately when using a wallet |
| Bitcoin Legacy P2PKH | `m/44'/0'/0'/0/0` | HASH160 of compressed key, Base58Check version `00` |
| Bitcoin Nested SegWit P2SH-P2WPKH | `m/49'/0'/0'/0/0` | P2WPKH redeem script, HASH160, Base58Check version `05` |
| Bitcoin Native SegWit P2WPKH | `m/84'/0'/0'/0/0` | HASH160 of compressed key, Bech32 witness v0 (`bc1q…`) |
| Bitcoin Taproot P2TR (BIP-86) | `m/86'/0'/0'/0/0` | BIP-86 internal key, BIP-341 `TapTweak`, Bech32m witness v1 (`bc1p…`) |
| TRON mainnet | `m/44'/195'/0'/0/0` | Keccak-256 of the public-key body, version `41`, double-SHA-256 Base58Check |
| BNB Beacon Chain (legacy BEP2) | `m/44'/714'/0'/0/0` | HASH160 of compressed key, Bech32 HRP `bnb`; distinct from BNB Smart Chain |

These are representative first-address profiles. Network selection does not connect to a chain or check balances. The Beacon profile is for historical/reference derivation; do not confuse it with BNB Smart Chain.

### Reproducible public test vector

For the public BIP-39 test mnemonic `abandon` repeated 11 times followed by `about`, with an empty passphrase and the paths above, the Bitcoin address outputs are:

- BIP-44 Legacy: `1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA`
- BIP-49 Nested SegWit: `37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf`
- BIP-84 Native SegWit: `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`
- BIP-86 Taproot: `bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr`
- BNB Beacon Chain profile at coin type 714: `bnb1rxhz5vdv4fvdjye8gxqvfv0yvg20jtlwf4f38d`

This is a publicly known test mnemonic only. Never use it or any sample phrase to hold funds.

## Bounded address search

For EVM profiles, the input also accepts a validated 33-byte compressed or 64/65-byte uncompressed secp256k1 public key and calculates its address directly. Otherwise, pasting a valid address and pressing **Search all 10,000,000 candidates** tests the complete scalar interval `1–10,000,000` by default. A match stops the other workers after their current small chunk and reports the scalar and public key; a miss covers only that interval. The operation runs entirely in browser Web Workers (up to four, depending on device cores); it does not send the address to EC2.

Workers partition the range and update each public point incrementally (`Q_(d+1) = Q_d + G`) instead of recomputing `dG` from scratch for every candidate. They compare address payload bytes directly, avoiding per-candidate address-string encoding. The measured rate and a device-specific remaining-time estimate are shown during the run. Full 10M runs can still take several minutes and consume substantial device CPU. The Stop control cancels at worker-chunk boundaries.

This is not practical recovery for a randomly generated real wallet: 10,000,000 is about `2^23` scalars, while secp256k1 has nearly `2^256` possible private scalars. A miss rules out only the tested interval. Keep this as a browser-side educational/test-range tool. A server-side EC2 search would require a compute API, expose the instance to abuse and unexpected CPU charges, and disclose the searched address to that server; it is not recommended for the public static site.

## Safety

The phrase is generated client-side with `@scure/bip39` using the browser cryptographic random source and is held only in page memory; values are not sent to a server. Clipboard actions expose values to the clipboard. The optional TXT export is unencrypted, includes the mnemonic, optional passphrase, seed, and private keys, and requires explicit confirmation. Treat that file as sensitive.

The public demo is HTTP-only unless separately configured for HTTPS. Never enter real wallet secrets until HTTPS and a trusted, reviewed build are established. This educational demo is not audited and must not be used to create a wallet for real funds.

## Deploy

The repository includes `vercel.json` and can be imported as a Vite project on Vercel (build command `npm run build`, output directory `dist`). It can also be deployed as a static site on Render with the same build command and `dist` publish directory.

For private EC2 hosting, see [the EC2 deployment guide](docs/ec2-deployment.md). Keep SSH/port 22 closed; serve only the static site publicly. The guide describes the configured deployment workflow and Systems Manager setup.
