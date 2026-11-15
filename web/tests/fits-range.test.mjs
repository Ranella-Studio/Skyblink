// Ported from Ranella-Studio/Nasa-Challenge (first version): web/tests/fits-range.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTail } from '../src/fits/fits.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(status, bytes) {
  const body = Uint8Array.from(bytes);
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

test('HTTP 200 body longer than n returns exactly the last n bytes', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.test/a.fits');
    assert.equal(init.headers.Range, 'bytes=-3');
    return mockResponse(200, [1, 2, 3, 4, 5, 6, 7, 8]);
  };
  const out = await fetchTail('https://example.test/a.fits', 3);
  assert.deepEqual(out, Uint8Array.from([6, 7, 8]));
});

test('HTTP 206 returns the ranged body unchanged', async () => {
  const body = [9, 8, 7, 6];
  globalThis.fetch = async () => mockResponse(206, body);
  const out = await fetchTail('https://example.test/a.fits', 3);
  assert.deepEqual(out, Uint8Array.from(body));
});

test('HTTP 404 throws an error with code 404 and fetch is called once', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(404, []);
  };
  await assert.rejects(
    () => fetchTail('https://example.test/missing.fits', 10),
    (err) => err.code === 404 && err.message === 'not found',
  );
  assert.equal(calls, 1);
});

test('a failing attempt then a 206 succeeds', async () => {
  let calls = 0;
  const body = [1, 2, 3, 4];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network');
    return mockResponse(206, body);
  };
  const out = await fetchTail('https://example.test/a.fits', 4, { tries: 2 });
  assert.deepEqual(out, Uint8Array.from(body));
  assert.equal(calls, 2);
});
