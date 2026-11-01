// Job store abstraction.
// - MemoryStore: used for local dev/tests (in-process, non-persistent).
// - DynamoStore: used in AWS mode (persists job state across Lambda invocations).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.JOBS_TABLE || 'seedlab-scan-jobs';

export class MemoryStore {
  constructor() {
    this.jobs = new Map();
  }

  async createJob(jobId, total) {
    const job = {
      jobId,
      status: 'processing',
      total,
      processed: 0,
      results: [],
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    return job;
  }

  async updateJob(jobId, patch) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    return job;
  }

  async appendResults(jobId, newResults) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.results.push(...newResults);
    job.processed = job.results.length;
    job.updatedAt = Date.now();
    return job;
  }

  async getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }
}

export class DynamoStore {
  constructor() {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async createJob(jobId, total) {
    const item = {
      jobId,
      status: 'processing',
      total,
      processed: 0,
      results: [],
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.client.send(new PutCommand({ TableName: TABLE, Item: item }));
    return item;
  }

  async updateJob(jobId, patch) {
    const setParts = [];
    const values = {};
    for (const [key, val] of Object.entries(patch)) {
      setParts.push(`#${key} = :${key}`);
      values[`:${key}`] = val;
    }
    values[':updatedAt'] = Date.now();
    setParts.push('#updatedAt = :updatedAt');
    await this.client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries([...Object.keys(patch), 'updatedAt'].map((k) => [`#${k}`, k])),
      ExpressionAttributeValues: values,
    }));
    return this.getJob(jobId);
  }

  async appendResults(jobId, newResults) {
    // Read-modify-write is fine for modest throughput; results are appended in batches.
    const job = await this.getJob(jobId);
    if (!job) return null;
    const results = [...(job.results || []), ...newResults];
    return this.updateJob(jobId, { results, processed: results.length });
  }

  async getJob(jobId) {
    const res = await this.client.send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
    return res.Item || null;
  }
}

export function createStore(mode = process.env.STORE_MODE || 'memory') {
  if (mode === 'aws' || mode === 'dynamo') return new DynamoStore();
  return new MemoryStore();
}
