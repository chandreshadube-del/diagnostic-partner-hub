/**
 * ============================================================================
 *  PROJECT DCP — Diagnostic Center Partnerships Web App  ·  v3.0.13
 *  Gynoveda Femtech Pvt Ltd
 *
 *  Stack: Google Apps Script (Code.gs + Index.html) + Google Sheets (22 tabs)
 *         + Google Drive (report PDFs, weekly backups). All Google Workspace.
 *
 *  Built from: Project_DCP_BRD_Intake_v1 (Workflow Edition, Sections 0–16)
 *              DCP_App_Master_Seed_v1.xlsx (22-tab master data)
 *
 *  Deploy: Deploy → New deployment → Web app → Execute as: Me,
 *          Who has access: Anyone. Run setup() once first (see SETUP.md).
 * ============================================================================
 */

const APP_VERSION = '3.0.13';
const TZ = 'Asia/Kolkata';

const SH = {
  CONFIG: 'Config', USERS: 'Users', REGIONS: 'Regions', AREAS: 'Areas', CLINICS: 'Clinics',
  PARTNERS: 'Partners', LABS: 'Labs', TESTS: 'Tests', PACKAGES: 'Packages', RATECARDS: 'RateCards',
  LEADS: 'Leads', LEADTESTS: 'LeadTests', REPORTS: 'Reports', MESSAGES: 'Messages', TEMPLATES: 'Templates',
  STATEMENTS: 'Statements', STLINES: 'StatementLines', TRANSFERS: 'Transfers', ALLOCATIONS: 'Allocations',
  AUDIT: 'Audit', FOOTFALL: 'ClinicFootfall', DUPES: 'DuplicateReviews'
};

const ROLE = { ADMIN: 'Admin', CM: 'Clinic Manager', PC: 'Partner Coordinator', LAB: 'Lab User' };

/** Lead statuses (BRD §4.1): 12 working + 2 admin. */
const ST = {
  GEN: 'Lead generated', CALLED: 'Called by lab', NR: 'Not reachable', BOOKED: 'Test booked',
  LABVISIT: 'Lab visit scheduled', HOME: 'Home sample collection', SAMPLE: 'Sample collected',
  DONE: 'Test done', REPORT: 'Test report generated', NI: 'Not interested', CANCEL: 'Cancelled',
  FU_AP: 'Follow-up: After period', FU_WDL: 'Follow-up: Will do later', DISPUTED: 'Disputed', CLOSED: 'Closed'
};
const FOLLOWUP_ST = [ST.FU_AP, ST.FU_WDL];
const TERMINAL_ST = [ST.NI, ST.CANCEL, ST.CLOSED];
const SCHEDULED_ST = [ST.LABVISIT, ST.HOME];

/** Revenue states (BRD §6.2). */
const REV = {
  EXPECTED: 'Expected', REPRICED: 'Re-priced', VOID: 'Void', EARNED: 'Earned',
  FROZEN: 'Frozen', COLLECTED: 'Collected', OUTSTANDING: 'Outstanding'
};

/** Mandatory dropdown lists (BRD §4.3, §6.4). */
const REASONS = {
  CANCEL: ['Done at another lab', 'Too far', 'Price', 'Not needed now', 'Duplicate', 'No response',
    'Wrong number', 'Test not available', 'Other (text)'],
  FOLLOWUP: ['Waiting for next cycle', 'Travelling', 'Personal', 'Other'],
  NOT_REACHABLE: ['No answer', 'Switched off', 'Wrong number'],
  PAYMENT_MODES: ['UPI', 'Cash', 'Card', 'Online', 'Other']
};

/**
 * Transition matrix (BRD §4.2). Role codes:
 *   P = Partner Coordinator (and Admin)   L = Lab User or Coordinator (and Admin)
 *   C = Clinic Manager (and Admin)        A = Admin only
 */
const TRANSITIONS = [
  [ST.GEN, ST.CALLED, 'P'], [ST.GEN, ST.NR, 'P'], [ST.GEN, ST.CANCEL, 'C'],
  [ST.CALLED, ST.BOOKED, 'P'], [ST.CALLED, ST.NI, 'P'], [ST.CALLED, ST.FU_AP, 'P'], [ST.CALLED, ST.FU_WDL, 'P'],
  [ST.NR, ST.CALLED, 'P'], [ST.NR, ST.CANCEL, 'A'],
  [ST.BOOKED, ST.LABVISIT, 'P'], [ST.BOOKED, ST.HOME, 'P'], [ST.BOOKED, ST.FU_AP, 'P'],
  [ST.BOOKED, ST.FU_WDL, 'P'], [ST.BOOKED, ST.CANCEL, 'P'],
  [ST.LABVISIT, ST.SAMPLE, 'L'], [ST.LABVISIT, ST.HOME, 'P'], [ST.LABVISIT, ST.FU_AP, 'P'],
  [ST.LABVISIT, ST.FU_WDL, 'P'], [ST.LABVISIT, ST.CANCEL, 'P'],
  [ST.HOME, ST.SAMPLE, 'L'], [ST.HOME, ST.LABVISIT, 'P'], [ST.HOME, ST.FU_AP, 'P'],
  [ST.HOME, ST.FU_WDL, 'P'], [ST.HOME, ST.CANCEL, 'P'],
  [ST.SAMPLE, ST.DONE, 'L'], [ST.SAMPLE, ST.CANCEL, 'P'],
  [ST.DONE, ST.REPORT, 'L'], [ST.DONE, ST.DISPUTED, 'A'],
  [ST.REPORT, ST.CLOSED, 'A'], [ST.REPORT, ST.DISPUTED, 'A'],
  [ST.FU_AP, ST.CALLED, 'P'], [ST.FU_WDL, ST.CALLED, 'P'], [ST.FU_AP, ST.CANCEL, 'A'], [ST.FU_WDL, ST.CANCEL, 'A'],
  [ST.DISPUTED, ST.DONE, 'A'], [ST.DISPUTED, ST.CANCEL, 'A'],
  [ST.NI, ST.CALLED, 'A'], [ST.NI, ST.BOOKED, 'A'], [ST.CANCEL, ST.CALLED, 'A'], [ST.CANCEL, ST.BOOKED, 'A']
];

function roleCodeAllows_(code, role) {
  if (role === ROLE.ADMIN) return true;
  if (code === 'P') return role === ROLE.PC;
  if (code === 'L') return role === ROLE.PC || role === ROLE.LAB;
  if (code === 'C') return role === ROLE.CM;
  return false; // 'A'
}

/** Config defaults — used when a key is missing from the Config tab. setup() adds the new ones. */
const CONFIG_DEFAULTS = {
  SESSION_TTL_HOURS: 12, TEMP_PW_EXPIRY_HOURS: 72, LOCKOUT_ATTEMPTS: 5, LOCKOUT_MINUTES: 15,
  SLA_CALL_HOURS: 24, SLA_BOOKING_HOURS: 48, SLA_SCHEDULE_HOURS: 24, SLA_TEST_DONE_DAYS: 7,
  PENDING_TEST_REMINDER_DAYS: '3,7,14', PENDING_TEST_MAX_DAYS: 14, UNREACHABLE_CANCEL_DAYS: 14,
  ADMIN_REOPEN_WINDOW_DAYS: 30, DUPLICATE_WINDOW_DAYS: 30, MIN_MARGIN_WARNING_PCT: 10,
  MAX_REPORT_PDF_MB: 10, MSG_MODE: 'MANUAL', M9_SURVEY_ENABLED: 'TRUE', AUTO_REFRESH_SECONDS: 60,
  SMS_FALLBACK_ENABLED: 'TRUE',
  KPI_TARGET_ADOPTION_PCT: 40, KPI_TARGET_CONVERSION_PCT: 25, KPI_TARGET_REPORT_ONTIME_PCT: 95,
  KPI_TARGET_COLLECTION_PCT: 90, KPI_TARGET_CSAT_PCT: 85, HOME_COLLECTION_FEE: 0,
  // Added in v3.0.0 build (setup() appends these rows if missing):
  PACKAGE_INDIVIDUAL_RULE: 'REQUIRE_COUPLE',
  M9_SURVEY_DELAY_DAYS: 3, SLA_CALL_WARN_HOURS: 2, SLA_CALL_PRIORITY_HOURS: 4,
  STATEMENT_DISPUTE_WINDOW_DAYS: 3, BACKUP_RETAIN_COUNT: 12, PASSWORD_MIN_LENGTH: 8,
  PBKDF2_ITERATIONS: 2000, SPOUSE_AGE_MIN: 18, SPOUSE_AGE_MAX: 80,
  PII_RETENTION_ENABLED: 'FALSE', PII_RETENTION_MONTHS: 24,
  MAX_PRESCRIPTION_MB: 8
};

const NEW_CONFIG_ROWS = [
  ['PACKAGE_INDIVIDUAL_RULE', 'REQUIRE_COUPLE', 'Workflow', 'Package with male components on an Individual female booking: REQUIRE_COUPLE (BRD §14 guardrail) or PATIENT_COMPONENTS_ONLY (book only the patient\'s components)'],
  ['M9_SURVEY_DELAY_DAYS', '3', 'Messaging', 'Days after Test report generated before M9 survey is due'],
  ['SLA_CALL_WARN_HOURS', '2', 'SLA', 'Queue warning after N hours in Lead generated'],
  ['SLA_CALL_PRIORITY_HOURS', '4', 'SLA', 'Priority flag after N hours in Lead generated'],
  ['STATEMENT_DISPUTE_WINDOW_DAYS', '3', 'Commercial', 'Days after statement generation that a partner can flag lines'],
  ['BACKUP_RETAIN_COUNT', '12', 'System', 'Weekly backup snapshots kept in /DCP Backups/'],
  ['PASSWORD_MIN_LENGTH', '8', 'Auth', 'Minimum password length (must contain letters and numbers)'],
  ['PBKDF2_ITERATIONS', '2000', 'Auth', 'PBKDF2-HMAC-SHA256 iterations for new password hashes'],
  ['SPOUSE_AGE_MIN', '18', 'Workflow', 'Minimum spouse age on Couple bookings'],
  ['SPOUSE_AGE_MAX', '80', 'Workflow', 'Maximum spouse age on Couple bookings'],
  ['APP_URL', '', 'System', 'Web-app /exec URL — paste it after Deploy → New deployment (used in emails, temp-password messages and the webhook URL)'],
  ['SMS_FALLBACK_ENABLED', 'TRUE', 'Messaging', 'API mode only: dispatch a DLT-registered SMS automatically if a WhatsApp (WABA) send fails (BRD §8.1). Needs Script Properties MSG_SMS_API_URL / MSG_SMS_API_TOKEN.'],
  ['PII_RETENTION_ENABLED', 'FALSE', 'Privacy', 'DPDP: scrub patient name/phone/address from Closed, Cancelled and Not-interested leads once they pass PII_RETENTION_MONTHS. Runs with the Sunday backup. OFF until you choose a retention period — nothing is ever deleted on a default.'],
  ['PII_RETENTION_MONTHS', '24', 'Privacy', 'Months after a lead is closed before its patient identifiers are scrubbed. Dates, status, clinic, partner, amounts, age, gender and pincode are kept so KPI and commission reports stay intact.'],
  ['MAX_PRESCRIPTION_MB', '8', 'System', 'Max prescription-pad photo size in MB (JPG/PNG)']
];

/* ----------------------------------------------------------------------------
 *  Errors
 * --------------------------------------------------------------------------*/
function fail_(msg, code) {
  const e = new Error(msg);
  e.userFacing = true;
  if (code) e.code = code;
  throw e;
}
function need_(cond, msg) { if (!cond) fail_(msg); }

/* ----------------------------------------------------------------------------
 *  Small helpers
 * --------------------------------------------------------------------------*/
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function num_(v) { if (v === '' || v === null || v === undefined) return 0; const n = Number(v); return isFinite(n) ? n : 0; }
function bool_(v) {
  if (v === true || v === false) return v;
  const s = str_(v).toUpperCase();
  return s === 'TRUE' || s === '=TRUE()' || s === 'YES' || s === 'Y' || s === '1';
}
function round2_(n) { return Math.round(Number(n || 0) * 100) / 100; }
function splitList_(v, sep) { return str_(v).split(sep || ',').map(s => s.trim()).filter(Boolean); }
function uniq_(arr) { const seen = {}; return arr.filter(x => (seen[x] ? false : (seen[x] = true))); }
function escRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function pick_(o, keys) { const r = {}; keys.forEach(k => { r[k] = o[k] === undefined ? '' : o[k]; }); return r; }
function clone_(o) { const r = {}; Object.keys(o).forEach(k => { if (k !== '_r') r[k] = o[k]; }); return r; }
/** Indian digit grouping without relying on Intl (e.g. 123456.5 → "1,23,456.50"). */
function inr_(n) {
  const v = round2_(num_(n));
  const neg = v < 0;
  const parts = Math.abs(v).toFixed(2).split('.');
  let int = parts[0];
  if (int.length > 3) int = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + int.slice(-3);
  return (neg ? '-' : '') + int + (parts[1] === '00' ? '' : '.' + parts[1]);
}
function median_(arr) {
  const a = arr.filter(x => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ----------------------------------------------------------------------------
 *  Dates — everything is stored as IST text: 'yyyy-MM-dd' or 'yyyy-MM-dd HH:mm'
 * --------------------------------------------------------------------------*/
function nowIST_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function todayIST_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function fmtDT_(d) { return d ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm') : ''; }
function fmtD_(d) { return d ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd') : ''; }
/** Parses IST text ('yyyy-MM-dd[ HH:mm[:ss]]' or 'dd-MM-yyyy[ HH:mm]') or a Date into a Date. */
function parseDT_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const m2 = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m2) m = [null, m2[3], m2[2], m2[1], m2[4], m2[5], null];
  }
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 330 * 60000;
  const d = new Date(utc);
  return isNaN(d.getTime()) ? null : d;
}
function addDaysStr_(dateStr, n) { const d = parseDT_(dateStr); return d ? fmtD_(new Date(d.getTime() + n * 86400000)) : ''; }
function hoursSince_(v, now) { const d = parseDT_(v); return d ? ((now || new Date()).getTime() - d.getTime()) / 3600000 : null; }
function daysBetweenDates_(a, b) { const da = parseDT_(str_(a).slice(0, 10)), db = parseDT_(str_(b).slice(0, 10)); return da && db ? Math.round((db - da) / 86400000) : null; }
function isValidDateStr_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(str_(s)) && !!parseDT_(s); }
function isValidDTStr_(s) { return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(str_(s)) && !!parseDT_(s); }

/* ----------------------------------------------------------------------------
 *  Sheet value normalisation (Sheets may auto-convert text to Date/number)
 * --------------------------------------------------------------------------*/
const DATE_ONLY_COLS = { ApptDate: 1, FollowUpDate: 1, PaymentDate: 1, TestDoneDate: 1, EffectiveFrom: 1, AgreementDate: 1,
  EffectiveDate: 1, TransferDate: 1, NextScanDate: 1 };
const MONTH_COLS = { MonthYYYYMM: 1 };
const TIME_COLS = { ApptSlot: 1 };
const TEXT_COLS = ['LeadID', 'LegacyCRMLeadID', 'Phone', 'Pincode', 'Mobile', 'ClinicPhone', 'LabPhone', 'SecondaryPhone',
  'LabManagerMobile', 'PrimaryContactMobile', 'EscalationContactMobile', 'RecipientPhone', 'HomeCollectionPincodes',
  'UTR', 'MonthYYYYMM', 'ApptDate', 'ApptSlot', 'FollowUpDate', 'PaymentDate', 'TestDoneDate', 'EffectiveFrom',
  'AgreementDate', 'EffectiveDate', 'TransferDate', 'CreatedAt', 'ConsentAt', 'RetryAt', 'SampleCollectedAt', 'TestDoneAt',
  'ReportGeneratedAt', 'ClosedAt', 'LastUpdatedAt', 'StatusChangedAt', 'NextScanDate', 'RxUploadedAt', 'AddedAt', 'DoneAt', 'UploadedAt',
  'SentAt', 'DeliveredAt', 'ReadAt', 'GeneratedAt', 'ConfirmedAt', 'RecordedAt', 'AllocatedAt', 'Timestamp', 'DetectedAt',
  'TempPasswordExpiry', 'LockedUntil', 'UpdatedAt', 'Version', 'ScopeIDs', 'PaymentRef', 'Value'];
const PHONEISH = { Phone: 1, Pincode: 1, Mobile: 1, ClinicPhone: 1, LabPhone: 1, SecondaryPhone: 1, LabManagerMobile: 1,
  PrimaryContactMobile: 1, EscalationContactMobile: 1, RecipientPhone: 1, HomeCollectionPincodes: 1, UTR: 1 };

function normCell_(h, v) {
  if (v instanceof Date) {
    if (MONTH_COLS[h]) return Utilities.formatDate(v, TZ, 'yyyy-MM');
    if (TIME_COLS[h]) return Utilities.formatDate(v, TZ, 'HH:mm');
    if (DATE_ONLY_COLS[h]) return fmtD_(v);
    return fmtDT_(v);
  }
  if (typeof v === 'number' && PHONEISH[h]) return String(Math.round(v));
  return v;
}

/* ----------------------------------------------------------------------------
 *  DB — tab access with per-execution cache. Writes happen under ScriptLock
 *  (acquired by the API dispatcher) so cached rows are always fresh.
 * --------------------------------------------------------------------------*/
const DB = (function () {
  let book = null;
  let cache = {};
  function openBook() {
    if (book) return book;
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!book) fail_('Spreadsheet not found. Open the DCP Google Sheet → Extensions → Apps Script and run setup() once.');
    return book;
  }
  function sheet(name) {
    const sh = openBook().getSheetByName(name);
    if (!sh) fail_('Missing tab "' + name + '" in the DCP workbook.');
    return sh;
  }
  function load(name) {
    if (cache[name]) return cache[name];
    const sh = sheet(name);
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    const values = lastRow > 0 && lastCol > 0 ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
    const headers = values[0].map(h => str_(h));
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      let empty = true;
      for (let j = 0; j < r.length; j++) { if (r[j] !== '' && r[j] !== null) { empty = false; break; } }
      if (empty) continue;
      const o = { _r: i + 1 };
      for (let j = 0; j < headers.length; j++) if (headers[j]) o[headers[j]] = normCell_(headers[j], r[j]);
      rows.push(o);
    }
    const t = { name: name, sh: sh, headers: headers, rows: rows, lastRow: Math.max(lastRow, 1), idx: {} };
    cache[name] = t;
    return t;
  }
  function rowArray(t, o) {
    return t.headers.map(h => (h && o[h] !== undefined && o[h] !== null ? o[h] : ''));
  }
  return {
    book: openBook,
    sheet: sheet,
    table: load,
    rows: function (name) { return load(name).rows; },
    headers: function (name) { return load(name).headers; },
    /** Indexed lookup by a key column (built once per execution). */
    get: function (name, key, val) {
      const t = load(name);
      if (!t.idx[key]) {
        const m = {};
        t.rows.forEach(r => { const k = str_(r[key]); if (k && !m[k]) m[k] = r; });
        t.idx[key] = m;
      }
      return t.idx[key][str_(val)] || null;
    },
    where: function (name, fn) { return load(name).rows.filter(fn); },
    insert: function (name, objs) {
      if (!Array.isArray(objs)) objs = [objs];
      if (!objs.length) return;
      const t = load(name);
      const data = objs.map(o => rowArray(t, o));
      const start = t.lastRow + 1;
      t.sh.getRange(start, 1, data.length, t.headers.length).setValues(data);
      objs.forEach((o, i) => { o._r = start + i; t.rows.push(o); });
      t.lastRow += data.length;
      t.idx = {};
    },
    update: function (name, o) {
      const t = load(name);
      need_(o && o._r, 'Internal: row reference missing for ' + name);
      t.sh.getRange(o._r, 1, 1, t.headers.length).setValues([rowArray(t, o)]);
      t.idx = {};
    },
    updateMany: function (name, objs) {
      if (!objs || !objs.length) return;
      const t = load(name);
      if (objs.length < 15) { objs.forEach(o => t.sh.getRange(o._r, 1, 1, t.headers.length).setValues([rowArray(t, o)])); t.idx = {}; return; }
      // Rewrite the contiguous block covering all changed rows in one call.
      const minR = Math.min.apply(null, objs.map(o => o._r)), maxR = Math.max.apply(null, objs.map(o => o._r));
      const byRow = {};
      t.rows.forEach(r => { if (r._r >= minR && r._r <= maxR) byRow[r._r] = r; });
      const current = t.sh.getRange(minR, 1, maxR - minR + 1, t.headers.length).getValues();
      const data = current.map((orig, i) => (byRow[minR + i] ? rowArray(t, byRow[minR + i]) : orig));
      t.sh.getRange(minR, 1, data.length, t.headers.length).setValues(data);
      t.idx = {};
    },
    hasColumn: function (name, col) { return load(name).headers.indexOf(col) >= 0; },
    reset: function () { cache = {}; }
  };
})();

/* ----------------------------------------------------------------------------
 *  Cross-request cache (CacheService — shared by every user hitting the
 *  script, unlike the per-execution DB cache above). Used for expensive
 *  read-heavy computations (the dashboard) that many concurrent users ask
 *  for the same answer to within seconds of each other. An "epoch" counter
 *  invalidates everything cached under it the moment any write happens, so
 *  cached data can be briefly shared (fast, cheap) but never stays stale
 *  past the next successful write.
 * --------------------------------------------------------------------------*/
function dashEpoch_() {
  const v = CacheService.getScriptCache().get('DASH_EPOCH');
  return v || '0';
}
function bumpDashEpoch_() {
  try { CacheService.getScriptCache().put('DASH_EPOCH', String(Number(dashEpoch_()) + 1), 21600); }
  catch (e) { /* best-effort — a failed bump just means one extra stale read, not a correctness bug */ }
}
/** Cache fn()'s JSON-serializable result for ttlSeconds under key, shared across all users/executions.
 *  Falls open on any CacheService error (size limit, quota) — always returns a correct, fresh result. */
function cached_(key, ttlSeconds, fn) {
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* corrupt or unreadable cache entry — fall through to recompute */ }
  const result = fn();
  try { cache.put(key, JSON.stringify(result), ttlSeconds); } catch (e) { /* value too large for cache (>100KB) — skip caching, still return fresh */ }
  return result;
}

/* ----------------------------------------------------------------------------
 *  Config
 * --------------------------------------------------------------------------*/
let CFG_ = null;
function cfg_() {
  if (CFG_) return CFG_;
  CFG_ = {};
  DB.rows(SH.CONFIG).forEach(r => { if (str_(r.Key)) CFG_[str_(r.Key)] = r.Value; });
  return CFG_;
}
function cfgRaw_(k) { const v = cfg_()[k]; return v === undefined || v === null || str_(v) === '' ? CONFIG_DEFAULTS[k] : v; }
function cfgNum_(k) { const n = Number(cfgRaw_(k)); return isFinite(n) ? n : Number(CONFIG_DEFAULTS[k] || 0); }
function cfgStr_(k) { return str_(cfgRaw_(k)); }
function cfgBool_(k) { return bool_(cfgRaw_(k)); }
function cfgList_(k) { return splitList_(cfgRaw_(k)).map(Number).filter(n => isFinite(n)); }

/* ----------------------------------------------------------------------------
 *  Sequential IDs (generated under lock). Counters persist in Script Properties
 *  and are re-synced against the sheet so manual rows never collide.
 * --------------------------------------------------------------------------*/
const SEQ_ = {};
function nextId_(table, col, prefix, width, sheetScan) {
  const key = 'SEQ|' + table + '|' + prefix;
  if (SEQ_[key] === undefined) {
    const props = PropertiesService.getScriptProperties();
    let n = Number(props.getProperty(key) || 0);
    if (sheetScan !== false) {
      const re = new RegExp('^' + escRe_(prefix) + '(\\d+)$');
      DB.rows(table).forEach(r => { const m = str_(r[col]).match(re); if (m) n = Math.max(n, Number(m[1])); });
    }
    SEQ_[key] = n;
  }
  SEQ_[key] += 1;
  PropertiesService.getScriptProperties().setProperty(key, String(SEQ_[key]));
  return prefix + String(SEQ_[key]).padStart(width, '0');
}

/* ----------------------------------------------------------------------------
 *  Audit (BRD §10.5) — buffered per execution, appended under lock.
 *  The Audit tab is append-only; the app never edits or deletes audit rows.
 * --------------------------------------------------------------------------*/
const AUDIT_BUF_ = [];
let LOCK_HELD_ = false;

function audit_(ctx, action, leadId, entity, ref, before, after, note) {
  AUDIT_BUF_.push({
    Timestamp: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    UserID: ctx ? ctx.userId : 'SYSTEM', UserEmail: ctx ? ctx.email : 'system', Role: ctx ? ctx.role : 'System',
    Action: action, LeadID: leadId || '', Entity: entity || '', EntityRef: ref || '',
    BeforeJSON: before ? JSON.stringify(before) : '', AfterJSON: after ? JSON.stringify(after) : '', Note: note || ''
  });
}

/** Returns only the fields that changed between two snapshots. */
function diff_(before, after) {
  const b = {}, a = {};
  Object.keys(after).forEach(k => {
    if (k === '_r' || k === 'LastUpdatedAt' || k === 'LastUpdatedBy') return;
    if (str_(before[k]) !== str_(after[k])) { b[k] = before[k] === undefined ? '' : before[k]; a[k] = after[k]; }
  });
  return { before: b, after: a };
}

function flushAudit_() {
  if (!AUDIT_BUF_.length) return;
  const run = function () {
    const sh = DB.sheet(SH.AUDIT);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => str_(h));
    const props = PropertiesService.getScriptProperties();
    let n = Number(props.getProperty('SEQ|Audit') || 0);
    if (!n) {
      const last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => {
        const m = str_(r[0]).match(/^AUD-(\d+)$/); if (m) n = Math.max(n, Number(m[1]));
      });
    }
    const rows = AUDIT_BUF_.splice(0, AUDIT_BUF_.length).map(o => {
      n += 1; o.AuditID = 'AUD-' + String(n).padStart(5, '0');
      return headers.map(h => (o[h] === undefined ? '' : o[h]));
    });
    props.setProperty('SEQ|Audit', String(n));
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  };
  if (LOCK_HELD_) run(); else withLock_(run);
}

function withLock_(fn) {
  if (LOCK_HELD_) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('The system is busy. Please try again in a few seconds.');
  LOCK_HELD_ = true;
  try { return fn(); } finally { LOCK_HELD_ = false; lock.releaseLock(); }
}

/* ----------------------------------------------------------------------------
 *  Lookups
 * --------------------------------------------------------------------------*/
function clinic_(id) { return DB.get(SH.CLINICS, 'ClinicID', id); }
function partner_(id) { return DB.get(SH.PARTNERS, 'PartnerID', id); }
function lab_(id) { return DB.get(SH.LABS, 'LabID', id); }
function test_(code) { return DB.get(SH.TESTS, 'TestCode', code); }
function package_(code) { return DB.get(SH.PACKAGES, 'PackageCode', code); }
function user_(id) { return DB.get(SH.USERS, 'UserID', id); }
function lead_(id) { return DB.get(SH.LEADS, 'LeadID', id); }
function mustLead_(id) { const l = lead_(id); need_(l, 'Lead ' + id + ' not found.'); return l; }
function clinicName_(id) { const c = clinic_(id); return c ? str_(c.Name) : str_(id); }
function partnerName_(id) { const p = partner_(id); return p ? str_(p.DisplayName || p.LegalName) : str_(id); }
function labName_(id) { const l = lab_(id); return l ? str_(l.LabName) : str_(id); }
/** Web-app URL: Config APP_URL (the /exec link from Deploy → Manage deployments) wins; getService().getUrl() can return a /dev link. */
function appUrl_() {
  const fixed = cfgStr_('APP_URL');
  if (/^https:\/\/script\.google\.com\/.+\/exec$/.test(fixed)) return fixed;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function sendMail_(to, subject, html) {
  const list = uniq_((Array.isArray(to) ? to : splitList_(to)).map(e => str_(e).toLowerCase()).filter(e => /@/.test(e)));
  if (!list.length) return false;
  try {
    MailApp.sendEmail({ to: list.join(','), subject: subject, htmlBody: html, name: 'Gynoveda DCP' });
    return true;
  } catch (e) {
    console.error('Mail failed: ' + subject + ' → ' + e.message);
    return false;
  }
}
function escHtml_(s) { return str_(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
