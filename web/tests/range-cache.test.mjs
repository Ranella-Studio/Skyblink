// Ported from Ranella-Studio/Nasa-Challenge (first version): web/tests/range-cache.test.mjs
// Ranges read from the archive are kept in Cache Storage, so a field seen
// before opens without the network. Node has no Cache Storage, so this file
// installs a small in-memory one before loading the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryCache {
  constructor() {
    this.map = new Map();
  }
  async match(key) {
    const hit = this.map.get(String(key));
    return hit && hit.clone();
  }
  async put(key, res) {
    this.map.delete(String(key));
    this.map.set(String(key), new Response(await res.arrayBuffer(), { headers: res.headers }));
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
  async delete(key) {
    return this.map.delete(typeof key === 'string' ? key : key.url);
  }
}
const store = new MemoryCache();
globalThis.caches = { open: async () => store };

let calls = 0;
const file = new Uint8Array(4096).map((_, i) => i & 255);
globalThis.fetch = async (url, { headers }) => {
  calls++;
  const [, a, b] = headers.Range.match(/bytes=(\d+)-(\d+)/);
  return new Response(file.slice(+a, +b + 1), { status: 206 });
};

const { fetchRange } = await import('../src/fits/fits.js');
const { trim } = await import('../src/fits/range-cache.js');
const URL1 = 'https://archive.test/qr3/level2/a.fits';

test('a range read twice comes from the browser the second time', async () => {
  const first = await fetchRange(URL1, 100, 199);
  await new Promise((r) => setTimeout(r, 10)); // the store is written in the background
  const again = await fetchRange(URL1, 100, 199);
  assert.equal(calls, 1);
  assert.deepEqual(again, first);
  assert.equal(again[0], 100);
});

test('a different range of the same file still goes to the network', async () => {
  await fetchRange(URL1, 0, 9);
  assert.equal(calls, 2);
});

test('expired ranges are read again', async () => {
  const key = [...store.map.keys()].find((k) => k.includes('bytes=100-199'));
  store.map.set(key, new Response(file.slice(100, 200), { headers: { 'x-stored': String(Date.now() - 31 * 86400e3) } }));
  await fetchRange(URL1, 100, 199);
  assert.equal(calls, 3);
  await new Promise((r) => setTimeout(r, 10));
});

test('the store is trimmed oldest first to its size limit', async () => {
  for (let k = 0; k < 4; k++) store.map.set(`https://archive.test/big${k}.fits?bytes=0-1&n=100000000`, new Response('xx'));
  await trim();
  const left = [...store.map.keys()];
  assert.ok(!left.some((k) => k.includes('big0') || k.includes('a.fits')), `oldest entries dropped: ${left}`);
  assert.ok(left.some((k) => k.includes('big3')), 'newest entries kept');
});
