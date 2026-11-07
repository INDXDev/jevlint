import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, readCache, writeCache } from '../src/cache.ts';
import { UserError } from '../src/config.ts';
import { entryUrl, readThrough, signedHeaders, writeThrough } from '../src/remote-cache.ts';

const key = cacheKey('entry');
const entry = { answers: { a: { value: 1 } }, inputTokens: 3 };

let dir: string;
let cache: { dir: string; remote: string; endpoint: string };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevlint-remote-'));
  cache = { dir, remote: 's3://bucket/team', endpoint: 'https://store.example' };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'id');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('entryUrl', () => {
  it('mirrors the local layout under the prefix, with or without a trailing slash', () => {
    const path = `/bucket/team/decisions/${key.slice(0, 2)}/${key}.json`;
    expect(entryUrl(cache, key).href).toBe(`https://store.example${path}`);
    expect(
      entryUrl({ ...cache, remote: 's3://bucket/team/', endpoint: 'https://store.example/' }, key)
        .pathname,
    ).toBe(path);
  });

  it('defaults to AWS in the configured region', () => {
    const { host } = entryUrl({ dir, remote: 's3://bucket', region: 'eu-west-1' }, key);
    expect(host).toBe('s3.eu-west-1.amazonaws.com');
  });
});

describe('signedHeaders', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const now = new Date('2026-11-05T01:02:03.456Z');

  // The expected signatures come from AWS's own @smithy/signature-v4.
  it('signs a GET as AWS does', () => {
    const url = new URL(
      'https://s3.eu-west-1.amazonaws.com/my.bucket/team/ci/decisions/ab/abc.json',
    );
    const { authorization } = signedHeaders(
      { method: 'GET', url, body: '' },
      credentials,
      'eu-west-1',
      now,
    );
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261105/eu-west-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=9fb5bb77781f7b5e7c585a8c1e6194e2c862dab5041be16d3f90ca2f29621fdf',
    );
  });

  it('signs a PUT with a session token and a port as AWS does', () => {
    const url = new URL('http://127.0.0.1:9000/b/decisions/ab/abc.json');
    const session = { ...credentials, sessionToken: 'tok/en+==' };
    const headers = signedHeaders(
      { method: 'PUT', url, body: '{"answers":{}}' },
      session,
      'auto',
      now,
    );
    expect(headers.authorization).toContain(
      'Signature=76be32db56b2f9edca0f3ffbe0e178fd7016cec6c65cd2a22fa7b36b3f38f118',
    );
    expect(headers['x-amz-security-token']).toBe('tok/en+==');
    expect(headers).not.toHaveProperty('host');
  });
});

describe('readThrough', () => {
  it('downloads a missing entry once, then reads it locally', async () => {
    fetchMock.mockResolvedValue(Response.json(entry));
    expect(await readThrough(cache, key)).toEqual(entry);
    expect(await readThrough(cache, key)).toEqual(entry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readCache(dir, key)).toEqual(entry);
  });

  it('stays local with no remote, and needs no credentials', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    expect(await readThrough({ dir }, key)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not ask the bucket for an entry it holds', async () => {
    await writeCache(dir, key, entry);
    expect(await readThrough(cache, key)).toEqual(entry);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing object', () => new Response('', { status: 404 })],
    ['an outage', () => new Response('', { status: 503 })],
    ['throttling', () => new Response('', { status: 429 })],
    ['a corrupt object', () => new Response('{not json')],
  ])('treats %s as a miss and stores nothing', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    expect(await readThrough(cache, key)).toBeUndefined();
    expect(await readCache(dir, key)).toBeUndefined();
  });

  it('releases the connection after a miss and after an upload', async () => {
    const outage = new Response('busy', { status: 503 });
    fetchMock.mockResolvedValueOnce(outage);
    await readThrough(cache, key);
    expect(outage.bodyUsed).toBe(true);
    const uploaded = new Response('ok');
    fetchMock.mockResolvedValueOnce(uploaded);
    await writeThrough(cache, key, entry);
    expect(uploaded.bodyUsed).toBe(true);
  });

  it('treats a network failure as a miss', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await readThrough(cache, key)).toBeUndefined();
  });

  it.each([400, 401, 403])('stops the run on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(new Response('<Secret/>', { status }));
    const read = readThrough(cache, key);
    await expect(read).rejects.toThrow(UserError);
    await expect(read).rejects.toThrow(`HTTP ${status}`);
  });

  it('stops the run when the bucket does not exist', async () => {
    const body = '<Error><Code>NoSuchBucket</Code></Error>';
    fetchMock.mockResolvedValue(new Response(body, { status: 404 }));
    await expect(readThrough(cache, key)).rejects.toThrow('no such bucket');
  });

  it('stops the run without credentials', async () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    await expect(readThrough(cache, key)).rejects.toThrow(UserError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('writeThrough', () => {
  it('stores locally and uploads the same JSON', async () => {
    fetchMock.mockResolvedValue(new Response(''));
    await writeThrough(cache, key, entry);
    expect(await readCache(dir, key)).toEqual(entry);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(entryUrl(cache, key));
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify(entry) });
  });

  it('does not upload with no remote', async () => {
    await writeThrough({ dir }, key, entry);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed upload', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['missing credentials', () => vi.stubEnv('AWS_ACCESS_KEY_ID', '')],
  ])('keeps the local entry after %s', async (_name, arrange) => {
    arrange();
    await expect(writeThrough(cache, key, entry)).resolves.toBeUndefined();
    expect(await readCache(dir, key)).toEqual(entry);
  });

  it('still uploads when the local directory cannot be written', async () => {
    fetchMock.mockResolvedValue(new Response(''));
    await writeCache(dir, 'plain', 1);
    const blocked = { ...cache, dir: join(dir, 'decisions', 'pl', 'plain.json', 'nested') };
    await expect(writeThrough(blocked, key, entry)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
