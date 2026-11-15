// Minimal PNG writer (8-bit grey or RGB) using only node:zlib and node:fs.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width, height, pixels, channels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const writePng = (path, { width, height, gray }) => writeFileSync(path, encodePng(width, height, gray, 1));
export const writePngRgb = (path, { width, height, rgb }) => writeFileSync(path, encodePng(width, height, rgb, 3));

// 3x5 pixel font for labels: digits, upper-case letters and a few marks.
const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '-': '000000111000000', '.': '000000000000010', ':': '000010000010000', '/': '001001010100100',
  '+': '000010111010000', '#': '101111101111101', '(': '010100100100010', ')': '010001001001010', ' ': '000000000000000',
};

/** Draw text (scale s) into an RGB buffer of width w. */
export function drawText(rgb, w, x0, y0, text, s = 2, color = [255, 255, 255]) {
  let x = x0;
  for (const ch of String(text).toUpperCase()) {
    const g = FONT[ch] ?? FONT[' '];
    for (let i = 0; i < 15; i++)
      if (g[i] === '1')
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) {
            const px = Math.round(x + (i % 3) * s + dx);
            const py = Math.round(y0 + Math.floor(i / 3) * s + dy);
            if (px >= 0 && px < w && py >= 0 && (py * w + px) * 3 + 2 < rgb.length) rgb.set(color, (py * w + px) * 3);
          }
    x += 4 * s;
  }
}

/**
 * Lay out tiles in a grid. tiles: array of { width, height, rgb } or null (blank),
 * in row-major order; labels: { rows: [..], cols: [..] }. Returns { width, height, rgb }.
 */
export function contactSheet(tiles, { cols, labels = {}, pad = 4, s = 2 }) {
  const tw = Math.max(...tiles.filter(Boolean).map((t) => t.width), 1);
  const th = Math.max(...tiles.filter(Boolean).map((t) => t.height), 1);
  const rows = Math.ceil(tiles.length / cols);
  const left = labels.rows ? Math.max(...labels.rows.map((l) => String(l).length)) * 4 * s + 2 * pad : pad;
  const top = labels.cols ? 7 * s + 2 * pad : pad;
  const width = left + cols * (tw + pad);
  const height = top + rows * (th + pad);
  const rgb = new Uint8Array(width * height * 3).fill(24);
  tiles.forEach((t, k) => {
    const x0 = left + (k % cols) * (tw + pad);
    const y0 = top + Math.floor(k / cols) * (th + pad);
    if (!t) return;
    for (let y = 0; y < t.height; y++) rgb.set(t.rgb.subarray(y * t.width * 3, (y + 1) * t.width * 3), ((y0 + y) * width + x0) * 3);
  });
  labels.cols?.forEach((l, c) => drawText(rgb, width, left + c * (tw + pad), pad, l, s));
  labels.rows?.forEach((l, r) => drawText(rgb, width, pad, Math.round(top + r * (th + pad) + th / 2 - 3 * s), l, s));
  return { width, height, rgb };
}
