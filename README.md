# Seedlab — an interactive wallet primer

A browser-based, step-by-step crypto wallet learning demo. It generates BIP-39 entropy and a 12-word phrase, derives the 512-bit seed and BIP-32 keys, then demonstrates address construction for Ethereum, BNB Smart Chain, TRON, and Bitcoin native SegWit (P2WPKH). A bounded client-side address candidate lab tests only a small range; it does not search the full keyspace.

## Run locally

```sh
npm install
npm run dev
```

Open the URL Vite prints (localhost is a secure context for browser cryptography). Build with `npm run build`.

## Address profiles

- Ethereum and BNB Smart Chain: `m/44'/60'/0'/0/0`, legacy Keccak-256, EIP-55. BNB Smart Chain is EVM-compatible, so the address is the same as Ethereum for the same key.
- TRON mainnet: `m/44'/195'/0'/0/0`, Keccak-256 plus Base58Check.
- Bitcoin mainnet native SegWit P2WPKH: `m/84'/0'/0'/0/0`, HASH160 plus Bech32 (`bc1q…`).

These are representative profiles, not every wallet variant. Bitcoin legacy, nested SegWit, Taproot, testnet, and BNB Beacon Chain are not included.

## Safety

The phrase is generated client-side with `@scure/bip39` using the browser cryptographic random source and is held only in page memory. It is not persisted or sent to a server; copying explicitly writes it to the clipboard. This educational demo is not audited and must not be used to create a wallet for real funds. A real wallet requires a security review and secure offline handling.

## Deploy

The repository includes `vercel.json` and can be imported as a Vite project on Vercel (build command `npm run build`, output directory `dist`). It can also be deployed as a static site on Render with the same build command and `dist` publish directory.

For private EC2 hosting with automatic deployments after merges to `main`, see [the EC2 setup guide](docs/ec2-deployment.md). The deployment workflow uses GitHub OIDC, private S3 releases, and AWS Systems Manager; it does not expose SSH or a public compute endpoint.

For a private EC2 setup with automated deployment on merges to `main`, follow [the EC2 deployment guide](docs/ec2-deployment.md). The GitHub Actions workflow uses OIDC and Systems Manager; it does not expose SSH or a public compute endpoint.
