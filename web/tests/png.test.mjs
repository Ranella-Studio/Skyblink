import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../../tools/png.mjs';

test('encodePng writes a valid 2x1 grey PNG', () => {
  const buf = encodePng(2, 1, new Uint8Array([0, 255]), 1);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
  // IHDR CRC for 2x1, 8-bit grey (computed independently with Python's zlib.crc32).
  assert.equal(buf.readUInt32BE(29), 0xd1492056);
  const idatLen = buf.readUInt32BE(33);
  assert.deepEqual([...inflateSync(buf.subarray(41, 41 + idatLen))], [0, 0, 255]);
});
