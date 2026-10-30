# Seedlab — an interactive wallet primer

A browser-based, step-by-step crypto wallet learning demo. Lesson 1 generates a BIP-39 12-word recovery phrase. Lesson 2 can derive and display the BIP-39 512-bit seed. It does not derive a private key, public key, or address.

## Run locally

```sh
npm install
npm run dev
```

Open the URL Vite prints (localhost is a secure context for browser cryptography). Build with `npm run build`.

## Safety

The phrase is generated client-side with `@scure/bip39` using the browser cryptographic random source and is held only in page memory. It is not persisted or sent to a server; copying explicitly writes it to the clipboard. This educational demo is not audited and must not be used to create a wallet for real funds. A real wallet requires a security review and secure offline handling.

## Deploy

The repository includes `vercel.json` and can be imported as a Vite project on Vercel (build command `npm run build`, output directory `dist`). It can also be deployed as a static site on Render with the same build command and `dist` publish directory.
