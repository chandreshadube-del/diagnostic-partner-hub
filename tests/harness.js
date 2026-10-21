/* Loads the real Apps Script sources, unmodified, into a Node vm context wired to the in-memory
 * service mocks, and exposes the same entry points the deployed web app has (api, doGet, doPost,
 * the scheduled jobs, setup). Files load in filename order — the order clasp pushes them and the
 * order the 00_..90_ prefixes are there to guarantee.
 */
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { build } = require('./fixtures/workbook.js');

const SRC = path.join(__dirname, '..', 'apps-script');

function createApp(opts) {
  opts = opts || {};
  const ctx = vm.createContext({ console: console, __node: { Buffer: Buffer, createHmac: crypto.createHmac, randomUUID: crypto.randomUUID } });
  const run = (code, filename) => vm.runInContext(code, ctx, { filename: filename || 'harness' });
  const ev = code => run(code);

  run(fs.readFileSync(path.join(__dirname, 'gas-mock.js'), 'utf8'), 'gas-mock.js');
  ev('__gas.htmlFiles.Index = ' + JSON.stringify(fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8')));
  ev('__gas.loadBook(' + JSON.stringify(JSON.stringify(opts.workbook || build())) + ')');
  ev('__gas.setNow("' + (opts.now || '2026-10-21T10:00:00+05:30') + '")');
  ev('__gas.props.SPREADSHEET_ID = "SYNTHETIC-WORKBOOK"');

  const files = fs.readdirSync(SRC).filter(f => /^\d\d_.*\.gs$/.test(f)).sort();
  files.forEach(f => run(fs.readFileSync(path.join(SRC, f), 'utf8'), f));

  // Record any field an insert/update carries that has no column on the tab: rowArray() drops it silently.
  ev(`globalThis.__dropped = {};
    ['insert', 'update', 'updateMany'].forEach(function (fn) {
      const orig = DB[fn];
      DB[fn] = function (name, x) {
        const hs = DB.headers(name);
        (Array.isArray(x) ? x : [x]).forEach(function (o) {
          Object.keys(o || {}).forEach(function (k) {
            if (k !== '_r' && hs.indexOf(k) < 0) { __dropped[name] = __dropped[name] || {}; __dropped[name][k] = (__dropped[name][k] || 0) + 1; }
          });
        });
        return orig.apply(this, arguments);
      };
    });`);

  const app = {
    ctx: ctx, ev: ev, files: files,
    json: expr => JSON.parse(ev('JSON.stringify(' + expr + ')') || 'null'),
    /** The real dispatcher: api(token, action, payload) -> parsed {ok,data|error,code}. */
    call(token, action, payload) {
      ctx.__t = token; ctx.__a = action; ctx.__p = JSON.stringify(payload === undefined ? {} : payload);
      return JSON.parse(ev('api(__t, __a, JSON.parse(__p))'));
    },
    /** Sign in and return the session token (throws with the server's message on failure). */
    login(email, password) {
      const r = app.call('', 'auth.login', { email: email, password: password || require('./fixtures/workbook.js').PASSWORD });
      if (!r.ok) throw new Error('login failed for ' + email + ': ' + r.error);
      return r.data.token;
    },
    setNow: iso => ev('__gas.setNow("' + iso + '")'),
    advanceHours(h) { ev('__gas.clock.offsetMs += ' + (h * 3600000)); },
    rows: name => app.json('__gas.sheetRows(' + JSON.stringify(name) + ')'),
    mail: () => app.json('__gas.mail'),
    clearMail: () => ev('__gas.mail.length = 0'),
    dropped: () => app.json('__dropped'),
    /** Invoke a global function (setup, dailyDigest, doGet ...) with JSON-able args. */
    fn(name, args) {
      ctx.__args = JSON.stringify(args || []);
      const s = ev('(function(){ const r = ' + name + '.apply(null, JSON.parse(__args)); return r === undefined ? null : JSON.stringify(r); })()');
      return s === null ? null : JSON.parse(s);
    }
  };
  return app;
}

/** Minimal valid PDF bytes (header + padding + EOF marker), base64. */
const pdfB64 = (opts) => {
  opts = opts || {};
  const body = (opts.noHeader ? 'XXXX-1.4\n' : '%PDF-1.4\n') + '1 0 obj<<>>endobj\n'.repeat(8) + (opts.noEof ? '' : '%%EOF\n');
  return Buffer.from(body, 'latin1').toString('base64');
};

module.exports = { createApp, pdfB64 };
