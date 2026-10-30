# Seedlab — an interactive wallet primer

A browser-based, step-by-step crypto wallet learning demo. It generates BIP-39 entropy and a 12-word phrase, derives the 512-bit seed and BIP-32 keys, then shows address-construction traces for Ethereum, Bitcoin, TRON, and BNB profiles. All derivations and the bounded address-search lab run locally in the browser.

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

For EVM profiles, the input also accepts a validated 33-byte compressed or 64/65-byte uncompressed secp256k1 public key; it computes the full public-key Keccak-256 digest and address directly, without attempting private-key recovery. Otherwise, the lab validates an address and tests secp256k1 scalars in batches of 256. After a miss, you can explicitly continue with the next interval (257–512, and so on) up to the strict overall cap of `1–10,000,000`; it never searches beyond that bound. The Auto-search button can run from the next untested scalar through the cap and be stopped from the page; it is browser-side only, so the tab/device must stay awake. It does not run on EC2. Each run reports measured elapsed time and candidate rate. The time estimate extrapolates blind address-preimage work (about `2^160` candidates for 20-byte address outputs, about `2^255` for Taproot x-only outputs) at the latest measured rate. This is not a practical key-recovery method, does not test arbitrary private keys, and is not a full secp256k1 break. A miss rules out only the tested interval. If a public key is exposed, generic discrete-log attacks are a different problem and remain infeasible at these scales.

## Safety

The phrase is generated client-side with `@scure/bip39` using the browser cryptographic random source and is held only in page memory; values are not sent to a server. Clipboard actions expose values to the clipboard. The optional TXT export is unencrypted, includes the mnemonic, optional passphrase, seed, and private keys, and requires explicit confirmation. Treat that file as sensitive.

The public demo is HTTP-only unless separately configured for HTTPS. Never enter real wallet secrets until HTTPS and a trusted, reviewed build are established. This educational demo is not audited and must not be used to create a wallet for real funds.

## Deploy

The repository includes `vercel.json` and can be imported as a Vite project on Vercel (build command `npm run build`, output directory `dist`). It can also be deployed as a static site on Render with the same build command and `dist` publish directory.

For private EC2 hosting, see [the EC2 deployment guide](docs/ec2-deployment.md). Keep SSH/port 22 closed; serve only the static site publicly. The guide describes the configured deployment workflow and Systems Manager setup.
