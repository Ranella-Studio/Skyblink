import { defineConfig } from 'vite';

// Every host the page may fetch from. A plain static host may not send headers, so the
// policy ships as a <meta> tag in the build (frame-ancestors is ignored there,
// which suits us: embedding is a feature). Dev mode skips it so hot reload works.
const CONNECT = [
  "'self'",
  'https://nasa-irsa-spherex.s3.amazonaws.com',
  'https://nasa-irsa-wise.s3.us-west-2.amazonaws.com',
  'https://stpubdata.s3.amazonaws.com',
  'https://alasky.cds.unistra.fr',
  'https://alaskybis.cds.unistra.fr',
  'https://simbad.cds.unistra.fr',
  'https://tapvizier.cds.unistra.fr',
  'https://ssp.imcce.fr',
  'https://irsa.ipac.caltech.edu',
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  `connect-src ${CONNECT.join(' ')}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = {
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
};

export default defineConfig({
  base: './',
  plugins: [csp],
  build: { target: 'es2022' },
});
