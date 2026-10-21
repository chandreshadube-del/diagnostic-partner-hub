/* Serves the real Index.html and stands in for Google's `google.script.run`, forwarding each call to the real api()
 * running in the Node vm (tests/harness.js). Apps Script injects google.script.run into the page; this does the same
 * with a ~15-line shim, so the client code under test is byte-for-byte what is deployed.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SHIM = `<script>
(function () {
  function make(ok, fail) {
    return {
      withSuccessHandler: function (f) { return make(f, fail); },
      withFailureHandler: function (f) { return make(ok, f); },
      api: function (token, action, payload) {
        fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token, action: action, payload: payload }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (ok) ok(j.raw); })
          .catch(function (e) { if (fail) fail({ message: String((e && e.message) || e) }); });
      }
    };
  }
  window.google = { script: { run: make(null, null) } };
})();
</script>`;

function startBridge(app) {
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'Index.html'), 'utf8');
  if (!index.includes('<head>')) throw new Error('Index.html has no <head> to inject the shim into');
  const page = index.replace('<head>', '<head>' + SHIM);
  const calls = [];                                              // every server call the page made, for assertions
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { token, action, payload } = JSON.parse(body);
          const raw = app.callRaw(token, action, payload);
          const r = JSON.parse(raw);
          calls.push({ action: action, ok: r.ok, error: r.error || '', code: r.code || '' });
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ raw: raw }));
        } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e && e.stack || e)); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/', calls: calls, close: () => new Promise(r => server.close(r))
  })));
}

module.exports = { startBridge };
