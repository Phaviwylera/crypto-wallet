// S3 helpers for the serverless upload flow.
// In AWS mode the browser is given a presigned PUT URL; after the file lands in
// S3, an S3 event triggers lambda.js which reads it back and runs the scan.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.UPLOADS_BUCKET || 'seedlab-uploads';
const REGION = process.env.AWS_REGION || 'us-east-1';
const client = new S3Client({ region: REGION });

export function listUploadsBucket() {
  return {
    name: BUCKET,
    async createPresignedUploadUrl(jobId) {
      const key = `uploads/${jobId}.bin`;
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/octet-stream' });
      const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
      return { uploadUrl, key, bucket: BUCKET };
    },
    async getObjectBody(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    },
  };
}

export function getUploadsBucketName() {
  return BUCKET;
}
