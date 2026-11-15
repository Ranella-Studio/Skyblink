// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/fits/range-cache.js
// Keeps byte ranges read from NASA's archive in the browser's Cache Storage,
// so a field or story seen before opens from disk instead of the network.
//
// Archive files never change under the same name (a reprocessed week gets a
// new folder), so a stored range stays valid; entries still expire after
// MAX_AGE in case NASA ever replaces a file in place. The store is trimmed to
// MAX_BYTES, oldest first. Anything going wrong (private browsing, storage
// full, no Cache Storage outside HTTPS) just means reading from the network.

const NAME = 'skyblink-archive-v1';
const MAX_BYTES = 300e6;
const MAX_AGE = 30 * 86400e3;

let store;
function open() {
  if (store === undefined) {
    store = typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(NAME).catch(() => null);
  }
  return store;
}

// The size rides along in the key, so trimming never has to read an entry.
const keyOf = (url, start, end) => `${url}?bytes=${start}-${end}&n=${end - start + 1}`;

export async function cachedRange(url, start, end) {
  try {
    const c = await open();
    const res = c && (await c.match(keyOf(url, start, end)));
    if (!res) return null;
    if (Date.now() - Number(res.headers.get('x-stored')) > MAX_AGE) {
      c.delete(keyOf(url, start, end));
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length === end - start + 1 ? buf : null;
  } catch {
    return null;
  }
}

// Small derived values (a detector's wavelength table) live in the same
// store under a name of their own.
const nameKey = (name) => `https://nasa-irsa-spherex.s3.amazonaws.com/?skyblink=${encodeURIComponent(name)}&n=4096`;

export async function cachedValue(name) {
  try {
    const c = await open();
    const res = c && (await c.match(nameKey(name)));
    if (!res || Date.now() - Number(res.headers.get('x-stored')) > MAX_AGE) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function storeValue(name, value) {
  try {
    const c = await open();
    if (c) await c.put(nameKey(name), new Response(JSON.stringify(value), { headers: { 'x-stored': String(Date.now()) } }));
  } catch {
    // Not kept: it is read from the archive again next time.
  }
}

let pending = 0;
let trimTimer = 0;
export async function storeRange(url, start, end, bytes) {
  try {
    const c = await open();
    if (!c || bytes.length !== end - start + 1) return;
    await c.put(keyOf(url, start, end), new Response(bytes, { headers: { 'x-stored': String(Date.now()) } }));
    // Trim once things go quiet rather than after every write.
    pending++;
    clearTimeout(trimTimer);
    trimTimer = setTimeout(trim, pending > 40 ? 0 : 3000);
  } catch {
    // Storage full or unavailable: the next visit reads from the network.
  }
}

/** Drop the oldest ranges until the store is under MAX_BYTES (exported for tests). */
export async function trim() {
  pending = 0;
  try {
    const c = await open();
    if (!c) return;
    const keys = await c.keys(); // oldest first
    const size = (k) => Number(new URL(k.url).searchParams.get('n')) || 0;
    let total = keys.reduce((s, k) => s + size(k), 0);
    for (const k of keys) {
      if (total <= MAX_BYTES) break;
      total -= size(k);
      await c.delete(k);
    }
  } catch {
    // Nothing to do: the browser can evict the cache itself.
  }
}
