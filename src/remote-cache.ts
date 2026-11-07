/** The cache's optional S3-compatible bucket, behind the local directory. */
import { createHash, createHmac } from 'node:crypto';
import { entryName, readCache, writeCache } from './cache.ts';
import { type Config, UserError } from './config.ts';

type CacheConfig = Config['cache'];

/** The keys that sign a request, as AWS tools name them in the environment. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const DEFAULT_REGION = 'us-east-1';
const TIMEOUT_MS = 10_000;

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

function credentials(): S3Credentials {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new UserError('cache.remote needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  }
  return {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    sessionToken: AWS_SESSION_TOKEN || undefined,
  };
}

/** The object's URL. Path style, because a bucket name with a dot breaks TLS as a host name. */
export function entryUrl({ remote = '', endpoint, region }: CacheConfig, key: string): URL {
  const base = endpoint ?? `https://s3.${region ?? DEFAULT_REGION}.amazonaws.com`;
  const location = remote.replace(/^s3:\/\//, '').replace(/\/$/, '');
  return new URL(`${base.replace(/\/$/, '')}/${location}/${entryName(key)}`);
}

/** Derives the key for one day, region and service, as Signature Version 4 prescribes. */
function signingKey(secretAccessKey: string, day: string, region: string): Buffer {
  return [region, 's3', 'aws4_request'].reduce(hmac, hmac(`AWS4${secretAccessKey}`, day));
}

/** Signs a request with AWS Signature Version 4, which S3-compatible stores all accept. */
export function signedHeaders(
  { method, url, body }: { method: string; url: URL; body: string },
  { accessKeyId, secretAccessKey, sessionToken }: S3Credentials,
  region: string,
  now: Date,
): Record<string, string> {
  const timestamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const payloadHash = sha256(body);
  const headersToSign: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
    ...(sessionToken && { 'x-amz-security-token': sessionToken }),
  };
  const names = Object.keys(headersToSign).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headersToSign[name]}\n`).join('');
  const signedNames = names.join(';');
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedNames,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, timestamp, scope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, day, region), stringToSign).toString('hex');
  const { host: _, ...headers } = headersToSign; // fetch sets Host from the URL
  const credential = `${accessKeyId}/${scope}`;
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credential}, SignedHeaders=${signedNames}, Signature=${signature}`,
  };
}

async function send(cache: CacheConfig, method: 'GET' | 'PUT', key: string, body = '') {
  const url = entryUrl(cache, key);
  const region = cache.region ?? DEFAULT_REGION;
  return fetch(url, {
    method,
    headers: signedHeaders({ method, url, body }, credentials(), region, new Date()),
    body: method === 'PUT' ? body : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** A refusal repeats on every file, so it stops the run. An outage only costs a cache miss. */
async function downloadEntry(cache: CacheConfig, key: string): Promise<unknown> {
  const response = await send(cache, 'GET', key);
  const { status } = response;
  if (status === 404 && (await response.text()).includes('NoSuchBucket')) {
    throw new UserError(`${cache.remote}: no such bucket. Check cache.remote and cache.endpoint.`);
  }
  if (status === 404 || status === 429 || status >= 500) {
    // An unread body keeps its connection until garbage collection, and files run in parallel.
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    throw new UserError(
      `${cache.remote} refused the cache read (HTTP ${status}). Check the AWS_ credentials and cache.region, and that they may list, read and write the bucket.`,
    );
  }
  return JSON.parse(await response.text());
}

/** Reads an entry locally, or else downloads it once and keeps it. */
export async function readThrough<T>(cache: CacheConfig, key: string): Promise<T | undefined> {
  const local = await readCache<T>(cache.dir, key);
  if (local !== undefined || !cache.remote) return local;
  try {
    const value = await downloadEntry(cache, key);
    if (value !== undefined) await writeCache(cache.dir, key, value).catch(() => {});
    return value as T | undefined;
  } catch (error) {
    if (error instanceof UserError) throw error;
    return undefined;
  }
}

/** Stores an entry locally and in the bucket. The answer is paid for, so no failure may lose it. */
export async function writeThrough(cache: CacheConfig, key: string, value: unknown): Promise<void> {
  await Promise.allSettled([
    writeCache(cache.dir, key, value),
    ...(cache.remote
      ? [send(cache, 'PUT', key, JSON.stringify(value)).then(({ body }) => body?.cancel())]
      : []),
  ]);
}
