/* In-memory stand-ins for the Apps Script services the DCP server uses.
 *
 * This file is evaluated INSIDE the same vm context as the .gs files, so every object the
 * app sees shares one JS realm (Array.isArray, instanceof Date, etc. behave as they do in
 * Apps Script). Node-only helpers arrive through the injected `__node` global.
 *
 * Fidelity notes — each mirrors a real Apps Script behaviour the app depends on:
 *  - Utilities.base64Decode / getBytes / HMAC return SIGNED bytes (-128..127), like Java.
 *  - Sheets coerces strings written with setValues "as if typed" (dates -> Date, digits ->
 *    Number, TRUE/FALSE -> boolean) unless the column is plain-text formatted ('@').
 *  - Writes past the grid grow it; reads past the grid throw.
 *  - setValues rejects a data block whose shape differs from the target range.
 *  - ScriptLock is not re-entrant: a second tryLock while held returns false.
 *  - CacheService rejects values over 100 KB.
 *  - Trashed Drive files are not returned by getFiles().
 */
(function (g) {
  'use strict';
  const N = g.__node;
  const RealDate = g.Date;
  const clock = { offsetMs: 0 };

  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + clock.offsetMs); else super(...a); }
    static now() { return RealDate.now() + clock.offsetMs; }
  }
  g.Date = FakeDate;
  const nowMs = () => RealDate.now() + clock.offsetMs;

  /* ---------- Utilities ---------- */
  const signed = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
  const toBuf = v => (Array.isArray(v) ? N.Buffer.from(v.map(b => b & 0xff)) : N.Buffer.from(String(v), 'utf8'));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dtfCache = {};
  function tzParts(date, tz) {
    const dtf = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const o = {}; dtf.formatToParts(date).forEach(p => { o[p.type] = p.value; }); return o;
  }
  function formatDate(date, tz, fmt) {
    const p = tzParts(date, tz);
    return fmt.replace(/yyyy|yy|MMM|MM|dd|HH|mm|ss/g, t => ({ yyyy: p.year, yy: p.year.slice(2), MMM: MON[+p.month - 1], MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second })[t]);
  }
  function makeBlob(buf, contentType, name) {
    return { getBytes: () => signed(buf), getContentType: () => contentType || 'text/plain', getName: () => name || '', setName(n) { name = n; return this; }, _buf: buf };
  }
  g.Utilities = {
    formatDate: formatDate,
    getUuid: () => N.randomUUID(),
    base64Decode: s => signed(N.Buffer.from(String(s), 'base64')),
    base64Encode: v => toBuf(v).toString('base64'),
    newBlob: (data, contentType, name) => makeBlob(toBuf(data), contentType, name),
    computeHmacSha256Signature: (value, key) => signed(N.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
    sleep: () => {}
  };

  /* ---------- state the harness can poke ---------- */
  const gas = g.__gas = {
    clock: clock, props: {}, cache: {}, lockHeld: false, mail: [], mailFail: false, fetchCalls: [],
    fetchResponder: () => ({ code: 200, body: '{}' }), triggers: [], htmlFiles: {}, book: null, bound: true, folders: {}, files: {}, seq: 0,
    setNow(iso) { clock.offsetMs = RealDate.parse(iso) - RealDate.now(); }
  };

  /* ---------- PropertiesService ---------- */
  const propsObj = {
    getProperty: k => (Object.prototype.hasOwnProperty.call(gas.props, k) ? gas.props[k] : null),
    setProperty(k, v) { gas.props[k] = String(v); return propsObj; },
    deleteProperty(k) { delete gas.props[k]; return propsObj; },
    getProperties: () => Object.assign({}, gas.props)
  };
  g.PropertiesService = { getScriptProperties: () => propsObj };

  /* ---------- CacheService ---------- */
  const cacheObj = {
    get(k) { const e = gas.cache[k]; if (!e) return null; if (e.exp <= nowMs()) { delete gas.cache[k]; return null; } return e.v; },
    put(k, v, ttl) {
      if (String(k).length > 250) throw new Error('Argument too large: key');
      if (N.Buffer.byteLength(String(v)) > 100 * 1024) throw new Error('Argument too large: value');
      gas.cache[k] = { v: String(v), exp: nowMs() + Math.min(Number(ttl) || 600, 21600) * 1000 };
    },
    remove(k) { delete gas.cache[k]; }
  };
  g.CacheService = { getScriptCache: () => cacheObj };

  /* ---------- LockService (non re-entrant, like the real ScriptLock) ---------- */
  g.LockService = { getScriptLock: () => ({
    tryLock() { if (gas.lockHeld) return false; gas.lockHeld = true; return true; },
    releaseLock() { gas.lockHeld = false; }
  }) };

  /* ---------- Spreadsheet ---------- */
  const isEmpty = v => v === '' || v === undefined || v === null;
  function istDate(y, mo, d, h, mi, s) { return new FakeDate(RealDate.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0)) - 330 * 60000); }
  function coerce(v) {            // what Sheets does to a string written without a text format
    if (typeof v !== 'string') return v;
    let m;
    if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return istDate(m[1], m[2], m[3]);
    if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/))) return istDate(m[1], m[2], m[3], m[4], m[5], m[6]);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'TRUE') return true;
    if (v === 'FALSE') return false;
    return v;
  }
  class Range {
    constructor(sh, r, c, nr, nc) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('The coordinates or dimensions of the range are invalid.');
      this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc;
    }
    getValues() {
      const sh = this.sh;
      if (this.r + this.nr - 1 > sh.maxRows || this.c + this.nc - 1 > sh.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(sh._get(this.r + i, this.c + j)); out.push(row); }
      return out;
    }
    setValues(data) {
      if (!Array.isArray(data) || data.length !== this.nr) throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' + (data && data.length) + ' but the range has ' + this.nr + '.');
      data.forEach(row => { if (!Array.isArray(row) || row.length !== this.nc) throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' + (row && row.length) + ' but the range has ' + this.nc + '.'); });
      const sh = this.sh;
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) {
        const rr = this.r + i, cc = this.c + j;
        const textCell = rr >= 2 && sh.textCols.has(cc);
        sh._set(rr, cc, textCell ? data[i][j] : coerce(data[i][j]));
      }
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat(f) { if (f === '@') for (let j = 0; j < this.nc; j++) this.sh.textCols.add(this.c + j); return this; }
  }
  class Sheet {
    constructor(book, name, id) { this.book = book; this.name = name; this.id = id; this.cells = []; this.maxRows = 1000; this.maxCols = 26; this.textCols = new Set(); }
    getName() { return this.name; }
    getSheetId() { return this.id; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    _get(r, c) { const row = this.cells[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined || v === null ? '' : v; }
    _set(r, c, v) {
      while (this.cells.length < r) this.cells.push([]);
      const row = this.cells[r - 1]; while (row.length < c) row.push('');
      row[c - 1] = v === undefined || v === null ? '' : v;
      if (r > this.maxRows) this.maxRows = r;
      if (c > this.maxCols) this.maxCols = c;
    }
    getLastRow() { for (let r = this.cells.length; r >= 1; r--) if (this.cells[r - 1].some(v => !isEmpty(v))) return r; return 0; }
    getLastColumn() { let m = 0; this.cells.forEach(row => { for (let c = row.length; c >= 1; c--) if (!isEmpty(row[c - 1])) { if (c > m) m = c; break; } }); return m; }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
    appendRow(arr) { const r = this.getLastRow() + 1; this.getRange(r, 1, 1, arr.length).setValues([arr]); }
    deleteRow(i) { this.cells.splice(i - 1, 1); this.maxRows = Math.max(1, this.maxRows - 1); }
  }
  class Book {
    constructor(id) { this.id = id; this.sheets = []; this.tz = 'UTC'; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
  }
  g.SpreadsheetApp = {
    openById(id) { if (!gas.book || gas.book.id !== id) throw new Error('No item with the given ID could be found, or you do not have permission to access it.'); return gas.book; },
    getActiveSpreadsheet: () => (gas.bound ? gas.book : null),
    getUi() { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); }
  };
  /** spec: { id, sheets: [{ name, headers, rows, maxRows?, maxCols? }] } — values may be {"$d":"yyyy-MM-dd"} for IST dates. */
  gas.loadBook = function (specJson) {
    const spec = JSON.parse(specJson);
    const book = new Book(spec.id);
    spec.sheets.forEach((s, i) => {
      const sh = new Sheet(book, s.name, 1000 + i);
      if (s.maxCols) sh.maxCols = s.maxCols;
      sh.getRange(1, 1, 1, s.headers.length).setValues([s.headers]);
      s.rows.forEach((row, ri) => {
        const vals = s.headers.map((_, ci) => {
          const v = row[ci];
          if (v && typeof v === 'object' && v.$d) { const m = v.$d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return istDate(m[1], m[2], m[3]); }
          return v === undefined ? '' : v;
        });
        vals.forEach((v, ci) => sh._set(ri + 2, ci + 1, v));        // raw import: no coercion, no text format
      });
      if (s.maxRows) sh.maxRows = Math.max(sh.maxRows, s.maxRows);
      book.sheets.push(sh);
    });
    gas.book = book;
    const wf = new File('DCP workbook', makeBlob(N.Buffer.from('workbook'), 'application/vnd.google-apps.spreadsheet', 'DCP'), root);
    wf.id = spec.id; gas.files[spec.id] = wf;                  // DriveApp.getFileById(book.getId()) must resolve
  };
  gas.sheetRows = function (name) {
    const sh = gas.book.getSheetByName(name);
    const last = sh.getLastRow(), lc = sh.getLastColumn();
    if (last < 1) return [];
    const hdr = sh.getRange(1, 1, 1, lc).getValues()[0];
    const out = [];
    for (let r = 2; r <= last; r++) { const o = {}; hdr.forEach((h, c) => { if (h) o[h] = sh._get(r, c + 1); }); out.push(o); }
    return out;
  };

  /* ---------- Drive ---------- */
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  class File {
    constructor(name, blob, parent) { this.id = 'FILE' + (++gas.seq); this.name = name; this.blob = blob; this.parent = parent; this.trashed = false; this.created = new FakeDate(); gas.files[this.id] = this; }
    getId() { return this.id; } getName() { return this.name; } getBlob() { return this.blob; }
    setTrashed(b) {
      if (gas.trashFail || (gas.trashFailIds || []).indexOf(this.id) >= 0) throw new Error('Exception: You do not have permission to trash this file.');
      this.trashed = !!b; return this;
    }
    getDateCreated() { return this.created; }
    makeCopy(name, folder) { return (folder || this.parent).createFile(makeBlob(this.blob._buf, this.blob.getContentType(), name)); }
  }
  class Folder {
    constructor(name, parent) { this.id = 'FOLDER' + (++gas.seq); this.name = name; this.parent = parent; this.folders = []; this.files = []; gas.folders[this.id] = this; }
    getId() { return this.id; } getName() { return this.name; }
    getFoldersByName(n) { return iter(this.folders.filter(f => f.name === n)); }
    createFolder(n) { const f = new Folder(n, this); this.folders.push(f); return f; }
    createFile(blob) { const f = new File(blob.getName(), blob, this); this.files.push(f); return f; }
    getFiles() { return iter(this.files.filter(f => !f.trashed)); }
  }
  const root = new Folder('Root', null);
  g.DriveApp = {
    getRootFolder: () => root,
    getFolderById(id) { if (!gas.folders[id]) throw new Error('No item with the given ID could be found.'); return gas.folders[id]; },
    getFileById(id) { if (!gas.files[id]) throw new Error('No item with the given ID could be found.'); return gas.files[id]; }
  };

  /* ---------- Mail / Fetch / Script / Html / Content / Session ---------- */
  g.MailApp = { sendEmail(o) { if (gas.mailFail) throw new Error('Service invoked too many times for one day: email.'); gas.mail.push(o); } };
  g.UrlFetchApp = { fetch(url, opts) {
    gas.fetchCalls.push({ url: url, opts: opts });
    const r = gas.fetchResponder(url, opts);
    return { getResponseCode: () => r.code, getContentText: () => r.body };
  } };
  g.ScriptApp = {
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
    getProjectTriggers: () => gas.triggers.slice(),
    deleteTrigger(t) { gas.triggers = gas.triggers.filter(x => x !== t); },
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/EXAMPLE/dev' }),
    newTrigger(fn) {
      const t = { fn: fn, spec: {}, getHandlerFunction() { return fn; } };
      const b = {
        timeBased() { return b; }, atHour(h) { t.spec.hour = h; return b; }, everyDays(n) { t.spec.everyDays = n; return b; },
        onWeekDay(d) { t.spec.weekday = d; return b; }, inTimezone(z) { t.spec.tz = z; return b; },
        create() { gas.triggers.push(t); return t; }
      };
      return b;
    }
  };
  g.HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile(name) {
      if (!(name in gas.htmlFiles)) throw new Error('Cannot find the file "' + name + '".');
      const out = { content: gas.htmlFiles[name], title: '', meta: {}, setTitle(t) { out.title = t; return out; }, addMetaTag(k, v) { out.meta[k] = v; return out; }, setXFrameOptionsMode(m) { out.xframe = m; return out; } };
      return out;
    }
  };
  g.ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput(s) { const o = { content: s, setMimeType(m) { o.mime = m; return o; }, getContent: () => s }; return o; }
  };
  g.Session = { getActiveUser: () => ({ getEmail: () => 'owner@example.test' }) };
  g.Logger = { log: () => {} };
})(globalThis);
