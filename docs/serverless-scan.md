# Server-side wallet scan (upload → S3 → Lambda → DynamoDB)

This covers the **upload + scan** backend added to Seedlab. It is separate from the
static EC2 site described in `ec2-deployment.md`.

## What it does

1. The browser uploads a wallet file (seeds / mnemonics / private keys, one per line
   in `.txt`/`.csv`, or a JSON array).
2. In production the API returns a **presigned S3 PUT URL**; the browser uploads the
   file directly to S3. (In local/dev mode the bundled Node server accepts the
   multipart upload directly.)
3. An **S3 `ObjectCreated` event** triggers the **scan Lambda**.
4. The Lambda parses the file, derives each input's addresses for every supported
   network, and writes progress + results to a **DynamoDB** jobs table.
5. The UI **polls** `GET /api/scan/:jobId` and shows live progress, then the final
   results table.

All derivation reuses the same audited `@scure/*` and `@noble/*` libraries as the
browser app, so server results are byte-identical to the on-page derivation.

## Files

- `server/index.js` — Hono app. Local mode serves `dist/` + `/api`. AWS mode only
  serves the API (returns presigned URLs / job status).
- `server/lambda.js` — Lambda handler. Routes API Gateway events to the Hono app and
  S3 events to the scan worker.
- `server/lib/networks.mjs` — address derivation (port of the browser algorithm).
- `server/lib/parse.mjs` — file parsing (txt/csv/json).
- `server/lib/scan.mjs` — scan engine (derives + reports progress).
- `server/lib/store.mjs` — job store: in-memory (dev) or DynamoDB (aws).
- `server/lib/s3.mjs` — presigned-URL + object read helpers.
- `server/build-lambda.sh` — packages the Lambda zip (prod deps only).
- `infra/main.tf` — Terraform: S3 uploads bucket (encrypted, public-access-blocked,
  1-day lifecycle expiry), DynamoDB jobs table (TTL), Lambda, HTTP API Gateway, IAM,
  and the S3→Lambda notification.

## Deploy

```sh
# 1. Build the frontend
npm ci && npm run build

# 2. Package the Lambda
cd server && ./build-lambda.sh && cd ..   # writes infra/seedlab-scan.zip

# 3. Create infrastructure
cd infra
terraform init
terraform apply

# 4. Point the frontend at the API Gateway
export VITE_SCAN_API_BASE="$(terraform output -raw api_url)"
npm run build
# host dist/ on the EC2 static site, S3+CloudFront, Vercel, or Render
```

`terraform output api_url` prints the base URL. Set `VITE_SCAN_API_BASE` to it
**before** building the frontend so `fetch` calls hit the right origin. For
production, also tighten `cors_allowed_origin` in `infra/main.tf` to your real
frontend origin.

## Local development (no AWS)

```sh
npm run build
npm run server                 # http://localhost:8787  (serves dist/ + /api, in-memory store)
# or with live reload: run `npm run server` in one terminal and `npm run dev` in another
```

The Vite dev server proxies `/api` to `http://localhost:8787` (override with
`SCAN_SERVER_URL`). Uploads are scanned in-process and results are returned via the
same polling UI.

## Cost / safety notes

- Lambda timeout is set to 15 minutes (the max). Large files take longer and would
  need a different design (streaming / batch workers). Keep uploads modest.
- Uploaded objects auto-expire after 1 day; the bucket blocks all public access and
  is SSE-S3 encrypted. DynamoDB uses on-demand capacity.
- Only send **test** wallet material. The server derives addresses from whatever you
  upload; do not upload real seed phrases or private keys.
- This is an educational tool, not a key-recovery or balance-checking service.
