// AWS Lambda entry point. A single function serves two event sources:
//   1. API Gateway (HTTP API) -> /api/scan, /api/scan/:id, /health
//   2. S3 object-created event -> read the uploaded file and run the scan
import { handle } from '@hono/aws-lambda';
import { createApp } from './index.js';
import { listUploadsBucket, getUploadsBucketName } from './lib/s3.mjs';
import { parseWalletFile } from './lib/parse.mjs';
import { runScan } from './lib/scan.mjs';
import { DynamoStore } from './lib/store.mjs';

const app = createApp();
const apiHandler = handle(app);

function isS3Event(event) {
  return event && Array.isArray(event.Records) && event.Records[0]?.eventSource === 'aws:s3';
}

async function processS3Event(event) {
  const store = new DynamoStore();
  const bucket = listUploadsBucket();
  for (const record of event.Records) {
    const key = record.s3.object.key;
    const jobId = key.split('/').pop().replace(/\.bin$/, '');
    const buffer = await bucket.getObjectBody(key);
    let lines;
    try {
      lines = parseWalletFile(key, buffer);
    } catch (err) {
      await store.updateJob(jobId, { status: 'error', error: err.message });
      continue;
    }
    await store.updateJob(jobId, { status: 'processing', total: lines.length });
    try {
      await runScan(jobId, lines, store);
    } catch (err) {
      console.error('scan failed', jobId, err);
    }
  }
  return { statusCode: 200, body: 'ok' };
}

export const handler = async (event, context) => {
  if (isS3Event(event)) {
    return processS3Event(event);
  }
  return apiHandler(event, context);
};

export { getUploadsBucketName };
