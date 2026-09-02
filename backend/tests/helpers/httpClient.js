import http from 'node:http';

import { createApp } from '../../src/app.js';

/**
 * A tiny HTTP client built on `node:http` rather than `fetch`, specifically
 * so a test can attach a JSON body to a GET request — the Fetch spec (and
 * therefore undici) forbids a body on GET/HEAD, but that is exactly the shape
 * needed to prove a route ignores the body for authorization decisions.
 */

export async function startTestServer() {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  function request({ method = 'GET', path, cookie, body, headers: extraHeaders }) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = { ...extraHeaders };
      if (data !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      if (cookie) headers.Cookie = cookie;

      const req = http.request(
        { method, hostname: '127.0.0.1', port, path, headers },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            let json = null;
            if (raw) {
              try {
                json = JSON.parse(raw);
              } catch {
                json = null;
              }
            }
            const setCookieHeader = res.headers['set-cookie'];
            resolve({
              status: res.statusCode,
              json,
              raw,
              headers: res.headers,
              // The Cookie header value a subsequent request would send:
              // just "name=value", stripped of attributes like Path/HttpOnly.
              cookie: setCookieHeader ? setCookieHeader[0].split(';')[0] : null,
              setCookieHeader: setCookieHeader ? setCookieHeader[0] : null,
            });
          });
        },
      );
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
  }

  return { request, stop };
}
