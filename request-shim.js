// Minimal request shim using node http. Supports the subset used by the kettle plugin:
//   request({ url, method, timeout, json, maxAttempts }, (error, response, body) => {})
'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(opts, cb) {
  try {
    const u = new URL(opts.url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      timeout: typeof opts.timeout === 'number' ? opts.timeout : 8000,
    }, (res) => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const body = opts.json ? safeJson(buf.toString('utf8')) : buf.toString('utf8');
        cb(null, { statusCode: res.statusCode, headers: res.headers }, body);
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Request timed out after ${opts.timeout}ms`)); });
    req.on('error', err => cb(err));
    req.end();
  } catch (err) { cb(err); }
}
function safeJson(s){ try { return JSON.parse(s); } catch { return s; } }
module.exports = request;
