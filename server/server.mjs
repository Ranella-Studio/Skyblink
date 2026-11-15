// Skyblink web service: serves the built site (web/dist) and relays exactly two IRSA 2MASS calls,
// because IRSA sends no CORS headers. Node 22, no dependencies. PORT from the environment.
// Approach (allow-list, GET/HEAD only, no client headers forwarded, timeout) follows
// Ranella-Studio/Nasa-Challenge archive-proxy.mjs; the code is new.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';

const IRSA = 'https://irsa.ipac.caltech.edu';
const MAX_BYTES = 20e6;
const TIMEOUT_MS = 60e3;
const NUM = /^-?\d{1,3}(?:\.\d{1,10})?$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.fits': 'application/fits', '.bin': 'application/octet-stream', '.pack': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
};

function coords(s) {
  const parts = (s || '').split(',');
  if (parts.length !== 2 || !parts.every((p) => NUM.test(p))) return null;
  const [ra, dec] = parts.map(Number);
  return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? `${ra},${dec}` : null;
}

function exactly(q, keys) {
  return q.size === keys.length && keys.every((k) => q.getAll(k).length === 1);
}

/** '/irsa/...' request path+query -> the IRSA URL to fetch, rebuilt from validated values; null if not allowed. */
export function relayTarget(reqUrl) {
  if (!reqUrl.startsWith('/irsa/') || /[\\#%]/.test(reqUrl.split('?')[0])) return null;
  let u;
  try {
    u = new URL(reqUrl, 'http://relay.invalid');
  } catch {
    return null;
  }
  const q = u.searchParams;
  if (u.pathname === '/irsa/cgi-bin/2MASS/IM/nph-im_sia') {
    if (!exactly(q, ['POS', 'SIZE', 'FORMAT', 'band'])) return null;
    const pos = coords(q.get('POS'));
    const size = q.get('SIZE');
    if (!pos || !NUM.test(size) || !(Number(size) > 0 && Number(size) <= 0.5)) return null;
    if (q.get('FORMAT') !== 'image/fits' || !/^[JHK]$/.test(q.get('band'))) return null;
    return `${IRSA}/cgi-bin/2MASS/IM/nph-im_sia?POS=${pos}&SIZE=${Number(size)}&FORMAT=image/fits&band=${q.get('band')}`;
  }
  const m = u.pathname.match(/^\/irsa\/ibe\/data\/twomass\/allsky\/allsky\/(\d{6}[ns])\/(s\d{3})\/image\/([jhk]i\d{7}\.fits\.gz)$/);
  if (m) {
    if (!exactly(q, ['center', 'size', 'gzip'])) return null;
    const center = coords(q.get('center'));
    const size = (q.get('size').match(/^(\d{1,2}(?:\.\d{1,6})?)arcmin$/) || [])[1];
    if (!center || !size || !(Number(size) > 0 && Number(size) <= 30) || q.get('gzip') !== 'false') return null;
    return `${IRSA}/ibe/data/twomass/allsky/allsky/${m[1]}/${m[2]}/image/${m[3]}?center=${center}&size=${Number(size)}arcmin&gzip=false`;
  }
  return null;
}

/** A file under root for a request path, or null (traversal, missing, directory). '/' -> index.html. */
export function staticFile(root, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const file = resolve(root, `.${p}`);
  if (!file.startsWith(root + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

async function relay(target, req, res) {
  let upstream;
  try {
    // No client headers (cookies, auth, forwarding) are sent on.
    upstream = await fetch(target, { method: req.method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    res.writeHead(err.name === 'TimeoutError' ? 504 : 502, { 'Content-Type': 'text/plain' }).end('IRSA unavailable');
    return;
  }
  const len = Number(upstream.headers.get('content-length'));
  if (len > MAX_BYTES) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('IRSA answer too large');
    return;
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': upstream.ok ? 'public, max-age=86400' : 'no-store',
  });
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  let sent = 0;
  const body = Readable.fromWeb(upstream.body);
  body.on('data', (chunk) => {
    sent += chunk.length;
    if (sent > MAX_BYTES) body.destroy(new Error('too large'));
  });
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}

export function createApp({ root = fileURLToPath(new URL('../web/dist', import.meta.url)) } = {}) {
  root = resolve(root);
  return createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = req.url.split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (path.startsWith('/irsa/')) {
      const target = relayTarget(req.url);
      if (!target) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not relayed');
      else relay(target, req, res);
      return;
    }
    const file = staticFile(root, path);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 10000);
  createApp().listen(port, '0.0.0.0', () => console.log(`skyblink on :${port}`));
}
