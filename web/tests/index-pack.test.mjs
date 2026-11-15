// Ported from Ranella-Studio/Nasa-Challenge (first version): web/tests/index-pack.test.mjs
// The site downloads pointings.pack (gzip over byte-shuffled columns) instead
// of pointings.bin. Both are written by pipeline/build_index.py from the same
// rows, so unpacking the committed pack must give the committed bin exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { unpack, Pointings } from '../src/data/pointings.js';

const data = (f) => readFileSync(new URL(`../public/data/${f}`, import.meta.url));
const meta = JSON.parse(data('pointings.json'));
const bin = data('pointings.bin');
const pack = data('pointings.pack');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('the packed index unpacks to the plain index byte for byte', async () => {
  assert.ok(pack.length < 0.6 * bin.length, `pack is ${pack.length} of ${bin.length} bytes`);
  const out = new Uint8Array(await unpack(ab(pack), meta));
  assert.equal(out.length, bin.length);
  assert.ok(Buffer.from(out).equals(bin));
  assert.equal(new Pointings(meta, out.buffer).count, meta.count);
});

test('a pack that does not match the manifest is refused', async () => {
  const short = gzipSync(Buffer.alloc(25 * meta.count - 25));
  await assert.rejects(unpack(ab(short), meta), /does not match/);
});

test('folder names from any release are accepted, anything else is refused', () => {
  const m = structuredClone(meta);
  m.folders[0] = 'qr4/level2/2026W40_1A/l2b-v28-2026-300';
  assert.doesNotThrow(() => new Pointings(m, ab(bin)));
  m.folders[0] = 'https://evil.example/x';
  assert.throws(() => new Pointings(m, ab(bin)), /damaged/);
});
