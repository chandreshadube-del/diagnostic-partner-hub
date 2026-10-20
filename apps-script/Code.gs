/**
 * ============================================================================
 *  PROJECT DCP — Diagnostic Center Partnerships Web App  ·  v3.0.3
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

const APP_VERSION = '3.0.3';
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
  PII_RETENTION_ENABLED: 'FALSE', PII_RETENTION_MONTHS: 24
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
  ['PII_RETENTION_MONTHS', '24', 'Privacy', 'Months after a lead is closed before its patient identifiers are scrubbed. Dates, status, clinic, partner, amounts, age, gender and pincode are kept so KPI and commission reports stay intact.']
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
  'ReportGeneratedAt', 'ClosedAt', 'LastUpdatedAt', 'StatusChangedAt', 'NextScanDate', 'AddedAt', 'DoneAt', 'UploadedAt',
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
/* ============================================================================
 *  AUTH (BRD §2.2) — app-managed logins, PBKDF2-HMAC-SHA256 salted hashes,
 *  Admin-issued temporary passwords, forced first change, lockout, sessions.
 * ==========================================================================*/

function hexToBytes_(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) { let b = parseInt(hex.substr(i, 2), 16); if (b > 127) b -= 256; out.push(b); }
  return out;
}
function bytesToHex_(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function randomHex_(nBytes) {
  let s = '';
  while (s.length < nBytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, nBytes * 2);
}

/** PBKDF2-HMAC-SHA256, single 32-byte block. Returns signed byte array. */
function pbkdf2_(password, saltBytes, iterations) {
  const key = Utilities.newBlob(String(password)).getBytes();
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const t = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}
/** Stored format: p2$<iterations>$<saltHex>$<hashHex> (matches the seed workbook). */
function hashPassword_(pw) {
  const iter = cfgNum_('PBKDF2_ITERATIONS') || 2000;
  const saltHex = randomHex_(8);
  return 'p2$' + iter + '$' + saltHex + '$' + bytesToHex_(pbkdf2_(pw, hexToBytes_(saltHex), iter));
}
function verifyPassword_(pw, stored) {
  const parts = str_(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'p2') return false;
  const iter = Number(parts[1]);
  if (!(iter > 0 && iter <= 200000)) return false;
  const calc = bytesToHex_(pbkdf2_(pw, hexToBytes_(parts[2]), iter));
  const want = parts[3].toLowerCase();
  if (calc.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function genTempPassword_() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = alpha + digits;
  const hex = randomHex_(20);
  let pw = '';
  for (let i = 0; i < 10; i++) pw += all[parseInt(hex.substr(i * 2, 2), 16) % all.length];
  // guarantee at least one letter and one digit
  pw = alpha[parseInt(hex.substr(20, 2), 16) % alpha.length] + pw.slice(1, 9) + digits[parseInt(hex.substr(22, 2), 16) % digits.length];
  return pw;
}

function checkPasswordPolicy_(pw) {
  const min = cfgNum_('PASSWORD_MIN_LENGTH') || 8;
  need_(typeof pw === 'string' && pw.length >= min, 'Password must be at least ' + min + ' characters.');
  need_(pw.length <= 64, 'Password must be at most 64 characters.');
  need_(/^[A-Za-z0-9]+$/.test(pw), 'Password must be alphanumeric (letters and numbers only).');
  need_(/[A-Za-z]/.test(pw) && /[0-9]/.test(pw), 'Password must contain at least one letter and one number.');
}

/* ----------------------------------------------------------------------------
 *  Sessions — CacheService (max 6h per put; refreshed on every request) with
 *  an absolute expiry of SESSION_TTL_HOURS.
 * --------------------------------------------------------------------------*/
function putSession_(token, s) {
  const ttl = Math.max(60, Math.min(21600, Math.floor((s.exp - Date.now()) / 1000)));
  CacheService.getScriptCache().put('S_' + token, JSON.stringify(s), ttl);
}
function createSession_(user, limited) {
  const token = randomHex_(24);
  putSession_(token, { u: str_(user.UserID), exp: Date.now() + cfgNum_('SESSION_TTL_HOURS') * 3600000, lim: !!limited });
  return token;
}
function getSession_(token) {
  if (!token || !/^[0-9a-f]{48}$/.test(String(token))) return null;
  const raw = CacheService.getScriptCache().get('S_' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.exp) { CacheService.getScriptCache().remove('S_' + token); return null; }
  putSession_(token, s);
  return s;
}
function removeSession_(token) { if (token) CacheService.getScriptCache().remove('S_' + token); }

function userByEmail_(email) {
  const e = str_(email).toLowerCase();
  return DB.rows(SH.USERS).find(r => str_(r.Email).toLowerCase() === e) || null;
}

/** Builds the request context for an authenticated session. */
function authCtx_(token, allowLimited) {
  const s = getSession_(token);
  if (!s) fail_('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  const u = user_(s.u);
  if (!u || !bool_(u.Active)) { removeSession_(token); fail_('Your access has been deactivated. Contact the DCP Admin.', 'SESSION_EXPIRED'); }
  if (s.lim && !allowLimited) fail_('Please set a new password to continue.', 'PASSWORD_CHANGE_REQUIRED');
  const ctx = buildCtx_(u);
  ctx.token = token;
  ctx.limited = !!s.lim;
  return ctx;
}

function buildCtx_(u) {
  const ctx = {
    user: u, userId: str_(u.UserID), email: str_(u.Email), name: str_(u.Name), role: str_(u.Role),
    orgType: str_(u.OrgType), orgId: str_(u.OrgID), scopeType: str_(u.ScopeType).toUpperCase(),
    scopeIds: splitList_(u.ScopeIDs), partnerId: '', labIds: [], clinicIds: []
  };
  if (ctx.role === ROLE.PC) ctx.partnerId = ctx.orgId;
  if (ctx.role === ROLE.LAB) {
    ctx.labIds = ctx.scopeType === 'LAB' && ctx.scopeIds.length ? ctx.scopeIds : [ctx.orgId];
    const lb = lab_(ctx.labIds[0]);
    ctx.partnerId = lb ? str_(lb.PartnerID) : '';
  }
  if (ctx.role === ROLE.CM) ctx.clinicIds = uniq_([ctx.orgId].concat(ctx.scopeType === 'CLINIC' ? ctx.scopeIds : []).filter(Boolean));
  ctx.clinicScope = clinicScopeSet_(ctx);
  return ctx;
}

/** Region → Area → Clinic scope cascade (BRD §2.4). Returns null for whole-network scope. */
function clinicScopeSet_(ctx) {
  if (ctx.role === ROLE.ADMIN || ctx.scopeType === 'ALL') return null;
  const set = {};
  if (ctx.role === ROLE.LAB) return set; // lab users are scoped by LabID, not clinics
  const clinics = DB.rows(SH.CLINICS);
  if (ctx.scopeType === 'REGION') clinics.forEach(c => { if (ctx.scopeIds.indexOf(str_(c.RegionID)) >= 0) set[str_(c.ClinicID)] = 1; });
  else if (ctx.scopeType === 'AREA') clinics.forEach(c => { if (ctx.scopeIds.indexOf(str_(c.AreaID)) >= 0) set[str_(c.ClinicID)] = 1; });
  else ctx.scopeIds.forEach(id => { set[id] = 1; });
  ctx.clinicIds.forEach(id => { set[id] = 1; });
  return set;
}

function inClinicScope_(ctx, clinicId) { return ctx.clinicScope === null || !!ctx.clinicScope[str_(clinicId)]; }

/** Server-side lead visibility (BRD §2.4 scope resolution rules). */
function canSeeLead_(ctx, lead) {
  switch (ctx.role) {
    case ROLE.ADMIN: return true;
    case ROLE.CM: return inClinicScope_(ctx, lead.ClinicID);
    case ROLE.PC: return str_(lead.PartnerID) === ctx.partnerId && inClinicScope_(ctx, lead.ClinicID);
    case ROLE.LAB: return !!str_(lead.AssignedLabID) && ctx.labIds.indexOf(str_(lead.AssignedLabID)) >= 0;
  }
  return false;
}
function assertSee_(ctx, lead) { need_(lead && canSeeLead_(ctx, lead), 'Lead not found or outside your access scope.'); }

/* ----------------------------------------------------------------------------
 *  Login / password flows
 * --------------------------------------------------------------------------*/
function login_(p) {
  const generic = 'Invalid email or password.';
  const email = str_(p.email).toLowerCase(), pw = String(p.password || '');
  need_(email && pw, 'Enter your email and password.');
  const u = userByEmail_(email);
  if (!u || !bool_(u.Active)) { Utilities.sleep(400); fail_(generic); }
  const now = new Date();
  const lockedUntil = parseDT_(u.LockedUntil);
  if (lockedUntil && lockedUntil > now) {
    fail_('Account locked after repeated failed attempts. Try again after ' + fmtDT_(lockedUntil) + ' IST, or use "Forgot password".');
  }
  const ctxLike = buildCtx_(u);
  if (!verifyPassword_(pw, u.PasswordHash)) {
    u.FailedAttempts = num_(u.FailedAttempts) + 1;
    let note = 'Failed attempt ' + u.FailedAttempts;
    if (u.FailedAttempts >= cfgNum_('LOCKOUT_ATTEMPTS')) {
      u.LockedUntil = fmtDT_(new Date(now.getTime() + cfgNum_('LOCKOUT_MINUTES') * 60000));
      u.FailedAttempts = 0;
      note = 'Locked until ' + u.LockedUntil;
    }
    DB.update(SH.USERS, u);
    audit_(ctxLike, 'LOGIN_FAILED', '', 'User', u.UserID, null, null, note);
    fail_(generic);
  }
  const force = bool_(u.ForcePasswordChange);
  if (force) {
    const exp = parseDT_(u.TempPasswordExpiry);
    if (exp && exp < now) fail_('Your temporary password has expired. Use "Forgot password" or ask the DCP Admin for a new one.');
  }
  if (num_(u.FailedAttempts) || str_(u.LockedUntil)) { u.FailedAttempts = 0; u.LockedUntil = ''; DB.update(SH.USERS, u); }
  const token = createSession_(u, force);
  audit_(ctxLike, 'LOGIN', '', 'User', u.UserID, null, null, force ? 'Temporary password — change required' : '');
  if (force) return { token: token, mustChangePassword: true, name: str_(u.Name) };
  const ctx = buildCtx_(u); ctx.token = token;
  return { token: token, mustChangePassword: false, boot: bootstrap_(ctx) };
}

function changePassword_(ctx, p) {
  const u = ctx.user;
  const newPw = String(p.newPassword || '');
  if (!ctx.limited) need_(verifyPassword_(String(p.currentPassword || ''), u.PasswordHash), 'Current password is incorrect.');
  checkPasswordPolicy_(newPw);
  need_(newPw === String(p.confirmPassword || ''), 'The two new passwords do not match.');
  need_(!verifyPassword_(newPw, u.PasswordHash), 'New password must be different from the current one.');
  u.PasswordHash = hashPassword_(newPw);
  u.ForcePasswordChange = false;
  u.TempPasswordExpiry = '';
  u.FailedAttempts = 0;
  u.LockedUntil = '';
  DB.update(SH.USERS, u);
  removeSession_(ctx.token);
  const token = createSession_(u, false);
  audit_(ctx, 'PASSWORD_CHANGED', '', 'User', u.UserID, null, null, '');
  const fresh = buildCtx_(u); fresh.token = token;
  return { token: token, boot: bootstrap_(fresh) };
}

/** Sets a new temporary password; returns it (shown once to the Admin for sharing). */
function issueTempPassword_(actorCtx, u, reason) {
  const temp = genTempPassword_();
  u.PasswordHash = hashPassword_(temp);
  u.ForcePasswordChange = true;
  u.TempPasswordExpiry = fmtDT_(new Date(Date.now() + cfgNum_('TEMP_PW_EXPIRY_HOURS') * 3600000));
  u.FailedAttempts = 0;
  u.LockedUntil = '';
  DB.update(SH.USERS, u);
  const url = appUrl_();
  const mailed = sendMail_(u.Email, 'Your Gynoveda DCP login',
    '<p>Hello ' + escHtml_(u.Name) + ',</p>' +
    '<p>Your Gynoveda DCP app login is ready.</p>' +
    '<p><b>App:</b> <a href="' + escHtml_(url) + '">' + escHtml_(url || '(link shared by your Admin)') + '</a><br>' +
    '<b>Login ID:</b> ' + escHtml_(u.Email) + '<br><b>Temporary password:</b> ' + escHtml_(temp) + '</p>' +
    '<p>You will be asked to set your own password at first sign-in. This temporary password expires on ' +
    escHtml_(u.TempPasswordExpiry) + ' IST.</p><p>— Gynoveda DCP</p>');
  audit_(actorCtx, 'TEMP_PASSWORD_ISSUED', '', 'User', u.UserID, null, null, reason + (mailed ? ' · emailed' : ' · email not sent'));
  return { tempPassword: temp, expires: u.TempPasswordExpiry, emailed: mailed, appUrl: url };
}

function forgotPassword_(p) {
  const email = str_(p.email).toLowerCase();
  const msg = 'If this email is registered, a new temporary password has been sent to it.';
  if (!email) return { message: msg };
  const cache = CacheService.getScriptCache();
  if (cache.get('FP_' + email)) return { message: msg };
  cache.put('FP_' + email, '1', 600);
  const u = userByEmail_(email);
  if (u && bool_(u.Active)) issueTempPassword_(buildCtx_(u), u, 'Forgot password');
  return { message: msg };
}

function logout_(ctx) { removeSession_(ctx.token); return { ok: true }; }
/* ============================================================================
 *  LEADS — catalogue, capture (BRD §3), routing (§5), rate freeze (§6.1),
 *  package explosion (§3.3), duplicates (§14), SLA timers (§4.5)
 * ==========================================================================*/

/* ---------- per-execution groupings ---------- */
let LINES_BY_LEAD_ = null, REPORTS_BY_LEAD_ = null, MSGS_BY_LEAD_ = null, RC_CACHE_ = {};
function resetGroups_() { LINES_BY_LEAD_ = null; REPORTS_BY_LEAD_ = null; MSGS_BY_LEAD_ = null; RC_CACHE_ = {}; }
function group_(table, key) {
  const m = {};
  DB.rows(table).forEach(r => { const k = str_(r[key]); if (k) (m[k] = m[k] || []).push(r); });
  return m;
}
function leadLines_(leadId) { if (!LINES_BY_LEAD_) LINES_BY_LEAD_ = group_(SH.LEADTESTS, 'LeadID'); return LINES_BY_LEAD_[str_(leadId)] || []; }
function activeLines_(leadId) { return leadLines_(leadId).filter(r => bool_(r.Active)); }
function leadReports_(leadId) { if (!REPORTS_BY_LEAD_) REPORTS_BY_LEAD_ = group_(SH.REPORTS, 'LeadID'); return REPORTS_BY_LEAD_[str_(leadId)] || []; }
function leadMessages_(leadId) { if (!MSGS_BY_LEAD_) MSGS_BY_LEAD_ = group_(SH.MESSAGES, 'LeadID'); return MSGS_BY_LEAD_[str_(leadId)] || []; }

/* ---------- rate card & catalogue ---------- */
/**
 * Rate card for a partner as of a given date: latest EffectiveFrom ≤ asOf per ItemCode
 * (BRD §6.1 versioning). asOf lets an in-flight lead keep the card version it was
 * captured on, so a mid-flight v2/v3 activation can't reprice part of one lead.
 */
function rateCardAsOf_(partnerId, asOf) {
  partnerId = str_(partnerId);
  asOf = str_(asOf).slice(0, 10) || todayIST_();
  const key = partnerId + '|' + asOf;
  if (RC_CACHE_[key]) return RC_CACHE_[key];
  const map = {};
  DB.rows(SH.RATECARDS).forEach(r => {
    if (str_(r.PartnerID) !== partnerId || str_(r.State) !== 'Active') return;
    const eff = str_(r.EffectiveFrom).slice(0, 10);
    if (eff && eff > asOf) return;
    const code = str_(r.ItemCode), cur = map[code];
    if (!cur || str_(cur.EffectiveFrom).slice(0, 10) <= eff) map[code] = r;
  });
  RC_CACHE_[key] = map;
  return map;
}

/** Active rate card for a partner (as of today). */
function activeRateCard_(partnerId) { return rateCardAsOf_(partnerId, todayIST_()); }

/**
 * Rate card to use when changing an existing lead: the version in force when the lead
 * was captured. Falls back to today's card for legacy rows with no CreatedAt.
 */
function rateCardForLead_(lead) {
  const asOf = str_(lead && lead.CreatedAt).slice(0, 10);
  return rateCardAsOf_(str_(lead && lead.PartnerID), asOf || todayIST_());
}

function isImagingTest_(code) { const t = test_(code); return !!t && str_(t.Category) === 'Imaging'; }
function testHomeAllowed_(code) { const t = test_(code); return !t || bool_(t.HomeCollectionAllowed); }

/** Normalised description of one rate-card line. */
function itemMeta_(r) {
  const code = str_(r.ItemCode), type = str_(r.ItemType) === 'Package' ? 'Package' : 'SingleTest';
  const m = {
    code: code, type: type, name: str_(r.ItemName), mrp: num_(r.MRP), price: num_(r.PatientPrice),
    margin: num_(r.GynovedaMarginRs), share: num_(r.PartnerB2BShareRs) || round2_(num_(r.PatientPrice) - num_(r.GynovedaMarginRs)),
    tat: num_(r.TATHours), home: bool_(r.HomeCollectionAllowed), visible: bool_(r.VisibleToClinics),
    rateCardId: str_(r.RateCardID), version: str_(r.Version), femaleCodes: [], maleCodes: [], scans: 1,
    gender: 'F/M', category: '', imaging: false
  };
  if (type === 'Package') {
    const pk = package_(code);
    m.femaleCodes = pk ? splitList_(pk.FemaleTestCodes) : [];
    m.maleCodes = pk ? splitList_(pk.MaleTestCodes) : [];
    m.gender = 'PKG';
    m.category = 'Package';
    const comps = m.femaleCodes.concat(m.maleCodes);
    m.imaging = (pk && bool_(pk.IncludesScans)) || comps.some(isImagingTest_);
    m.home = m.home && comps.every(testHomeAllowed_) && !m.imaging;
    m.components = {
      F: m.femaleCodes.map(c => ({ code: c, name: test_(c) ? str_(test_(c).Name) : c })),
      M: m.maleCodes.map(c => ({ code: c, name: test_(c) ? str_(test_(c).Name) : c }))
    };
    m.scans = 0;
  } else {
    const t = test_(code);
    if (t) {
      m.gender = bool_(t.MaleOnly) ? 'M' : (str_(t.GenderApplicability) || 'F/M');
      m.scans = Math.max(1, num_(t.ScansRequired) || 1);
      m.category = str_(t.Category);
      m.imaging = m.category === 'Imaging';
      m.home = m.home && bool_(t.HomeCollectionAllowed);
      m.prep = str_(t.PreparationNotes);
    }
  }
  return m;
}

/** Catalogue for a partner. clinicOnly → only VisibleToClinics items (BRD §3.3). */
function catalogue_(partnerId, clinicOnly, ctx) {
  const rc = activeRateCard_(partnerId);
  const showMargin = ctx && ctx.role === ROLE.ADMIN;
  return Object.keys(rc).map(code => itemMeta_(rc[code]))
    .filter(m => !clinicOnly || m.visible)
    .map(m => { if (!showMargin) { delete m.margin; delete m.share; } return m; })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'Package' ? -1 : 1));
}

/* ---------- routing (BRD §5) ---------- */
function activeLabsForClinic_(partnerId, clinicId) {
  return DB.where(SH.LABS, l => str_(l.PartnerID) === str_(partnerId) && str_(l.State) === 'Active' &&
    splitList_(l.ClinicIDServed).indexOf(str_(clinicId)) >= 0);
}
function routeForClinic_(c) {
  const pid = str_(c.DefaultPartnerID);
  if (!pid) return { error: 'No default diagnostic partner is mapped to ' + c.Name + '. Ask the DCP Admin to set one.' };
  const pt = partner_(pid);
  if (!pt || str_(pt.State) !== 'Active') return { error: 'The mapped partner (' + partnerName_(pid) + ') is not Active, so new leads can\'t be routed from ' + c.Name + '.' };
  const labs = activeLabsForClinic_(pid, c.ClinicID);
  if (!labs.length) return { error: partnerName_(pid) + ' has no Active lab serving ' + c.Name + ' yet. The DCP Admin must activate at least one lab for this clinic before leads can be captured (BRD §5.2).' };
  return { partnerId: pid, partner: pt, labs: labs };
}

/* ---------- validation ---------- */
const RE_PHONE = /^[6-9]\d{9}$/;
const RE_PIN = /^[1-9]\d{5}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanPhone_(v) { let s = str_(v).replace(/[\s-]/g, ''); if (/^(\+?91)\d{10}$/.test(s)) s = s.slice(-10); return s; }

function validatePatient_(p, c) {
  const o = {};
  o.PatientName = str_(p.patientName).replace(/\s+/g, ' ');
  need_(o.PatientName.length >= 2 && o.PatientName.length <= 80, 'Enter the patient\'s name (2–80 characters).');
  o.Gender = str_(p.gender).toUpperCase().charAt(0);
  need_(o.Gender === 'F' || o.Gender === 'M', 'Select the patient\'s gender.');
  o.Age = Number(p.age);
  need_(Number.isInteger(o.Age) && o.Age >= 18 && o.Age <= 65, 'Age must be a whole number between 18 and 65.');
  o.Phone = cleanPhone_(p.phone);
  need_(RE_PHONE.test(o.Phone), 'Enter a valid 10-digit Indian mobile number (starts with 6–9).');
  o.Pincode = str_(p.pincode);
  need_(RE_PIN.test(o.Pincode), 'Enter a valid 6-digit pincode.');
  o.BookingType = str_(p.bookingType) === 'Couple' ? 'Couple' : 'Individual';
  if (o.BookingType === 'Couple') {
    o.SpouseName = str_(p.spouseName).replace(/\s+/g, ' ');
    need_(o.SpouseName.length >= 2, 'Enter the spouse\'s name for a Couple booking.');
    o.SpouseAge = Number(p.spouseAge);
    need_(Number.isInteger(o.SpouseAge) && o.SpouseAge >= cfgNum_('SPOUSE_AGE_MIN') && o.SpouseAge <= cfgNum_('SPOUSE_AGE_MAX'),
      'Spouse age must be a whole number between ' + cfgNum_('SPOUSE_AGE_MIN') + ' and ' + cfgNum_('SPOUSE_AGE_MAX') + '.');
    o.SpouseGender = str_(p.spouseGender).toUpperCase().charAt(0);
    need_(o.SpouseGender === 'F' || o.SpouseGender === 'M', 'Select the spouse\'s gender.');
  } else { o.SpouseName = ''; o.SpouseAge = ''; o.SpouseGender = ''; }
  const doctors = splitList_(c.ReferringDoctors, '|').filter(d => !/^Other/i.test(d));
  const doc = str_(p.referringDoctor);
  if (/^Other/i.test(doc)) {
    const other = str_(p.referringDoctorOther);
    need_(other.length >= 2, 'Type the referring doctor\'s name.');
    o.ReferringDoctor = other.slice(0, 80);
  } else {
    need_(doctors.indexOf(doc) >= 0, 'Select the referring doctor from the list (or "Other — type name").');
    o.ReferringDoctor = doc;
  }
  o.Urgency = str_(p.urgency) === 'Urgent' ? 'Urgent' : 'Normal';
  o.PreferredMode = ['Lab visit', 'Home collection'].indexOf(str_(p.preferredMode)) >= 0 ? str_(p.preferredMode) : '';
  o.NotesForLab = str_(p.notesForLab).slice(0, 500);
  return o;
}

/* ---------- line building (rate freeze + package explosion + gender guardrails) ---------- */
function personGender_(lead, tag) {
  if (tag === 'P') return str_(lead.Gender);
  if (tag === 'S' && str_(lead.BookingType) === 'Couple') return str_(lead.SpouseGender);
  return '';
}
function genderFits_(applic, g) {
  const a = str_(applic).toUpperCase();
  if (!a || a === 'F/M' || a === 'M/F' || a === 'ALL') return true;
  return a === g;
}
function personLabel_(tag) { return tag === 'S' ? 'spouse' : tag === 'B' ? 'both' : 'patient'; }

function isPkgHeader_(line, lines) {
  if (str_(line.ItemType) !== 'Package') return false;
  const pre = str_(line.ItemCode) + ':';
  return lines.some(l => bool_(l.Active) && str_(l.ItemType) === 'PackageComponent' && str_(l.ItemCode).indexOf(pre) === 0);
}
/** Lines that must be completed individually (package headers with components are derived). */
function workLines_(lines) { const act = lines.filter(l => bool_(l.Active)); return act.filter(l => !isPkgHeader_(l, act)); }
function lineTestCode_(l) { const c = str_(l.ItemCode); return str_(l.ItemType) === 'PackageComponent' ? c.split(':')[1] : c; }

/**
 * Builds LeadTests rows for requested items.
 * items: [{code, tag}] — tag P/S/B for Couple bookings (ignored for Individual).
 */
function buildLines_(ctx, lead, items, rc, opts) {
  opts = opts || {};
  const now = nowIST_();
  const couple = str_(lead.BookingType) === 'Couple';
  const rule = cfgStr_('PACKAGE_INDIVIDUAL_RULE');
  const out = [], warnings = [], seen = {};
  const existing = opts.existing || [];
  existing.filter(l => bool_(l.Active)).forEach(l => { seen[str_(l.ItemCode) + '|' + str_(l.PersonTag)] = 1; });

  const base = function (meta, tag) {
    return {
      LeadTestID: '', LeadID: lead.LeadID, PersonTag: tag, ItemType: meta.type, ItemCode: meta.code, ItemName: meta.name,
      FrozenMRP: meta.mrp, FrozenPatientPrice: meta.price, FrozenMarginRs: meta.margin,
      PartnerShareRs: round2_(meta.price - meta.margin), ScansRequired: meta.scans, ScansDone: 0, IsDone: false,
      DoneAt: '', AddedByRole: ctx.role, AddedAt: now, Active: true,
      RateCardID: meta.rateCardId, RateCardVersion: meta.version
    };
  };

  /**
   * Single-test value of a package component on this partner's card, used only as the
   * basis for prorating a partial package. 0 means "not separately priced".
   */
  const compValue_ = function (tcode) {
    const r = rc[str_(tcode)];
    return r ? num_(r.PatientPrice) : 0;
  };

  (items || []).forEach(it => {
    const code = str_(it.code);
    const r = rc[code];
    need_(r, 'Item ' + code + ' is not on the partner\'s active rate card.');
    if (opts.clinicOnly) need_(bool_(r.VisibleToClinics), '"' + str_(r.ItemName) + '" is not yet available for clinic capture.');
    const meta = itemMeta_(r);
    need_(meta.price > 0, '"' + meta.name + '" has no patient price on the rate card.');

    if (meta.type === 'SingleTest') {
      const tag = couple ? (['P', 'S', 'B'].indexOf(str_(it.tag)) >= 0 ? str_(it.tag) : 'P') : 'P';
      (tag === 'B' ? ['P', 'S'] : [tag]).forEach(t => {
        const g = personGender_(lead, t);
        if (!genderFits_(meta.gender, g)) {
          if (meta.gender === 'M' && g === 'F' && !couple) fail_('"' + meta.name + '" is a male-only test and can\'t be booked on a Female Individual booking. Switch Booking Type to Couple and tag it to the spouse, or book for a male patient.');
          fail_('"' + meta.name + '" applies to ' + (meta.gender === 'M' ? 'male' : 'female') + ' patients only — it can\'t be tagged to the ' + personLabel_(t) + ' (' + (g === 'F' ? 'female' : 'male') + ').');
        }
        const k = code + '|' + t;
        need_(!seen[k], '"' + meta.name + '" is already on this lead for the ' + personLabel_(t) + '.');
        seen[k] = 1;
        out.push(base(meta, t));
      });
      return;
    }

    // Package: explode female components to the female person, male components to the male person.
    const persons = couple ? ['P', 'S'] : ['P'];
    const fTag = persons.find(t => personGender_(lead, t) === 'F') || '';
    const mTag = persons.find(t => personGender_(lead, t) === 'M') || '';
    let useF = meta.femaleCodes.length > 0, useM = meta.maleCodes.length > 0;
    let dropped = false;
    const missF = useF && !fTag, missM = useM && !mTag;
    if (missF || missM) {
      const missingSide = missM ? 'male' : 'female';
      const missingList = (missM ? meta.components.M : meta.components.F).map(c => c.name).join(', ');
      const canPartial = (missF && useM && mTag) || (missM && useF && fTag);
      if (rule === 'PATIENT_COMPONENTS_ONLY' && canPartial) {
        warnings.push('"' + meta.name + '": ' + missingSide + ' component(s) not included on this booking (' + missingList + '). Switch to Couple to include them.');
        if (missF) useF = false; if (missM) useM = false;
        dropped = true;
      } else {
        fail_('"' + meta.name + '" includes ' + missingSide + ' test(s) (' + missingList + '). Switch Booking Type to Couple and add the spouse\'s details to book this package.');
      }
    }

    /*
     * Partial package under PATIENT_COMPONENTS_ONLY: the package price is a bundle of its
     * components, so charging the full rate-card total after dropping one side overcharges
     * the patient. Prorate by the single-test value of the components actually booked.
     * If the components aren't individually priced we can't derive a fair share — block the
     * booking rather than guess at a price (BRD §6.1).
     */
    let prorate = 1;
    if (dropped) {
      const valF = meta.femaleCodes.reduce((a, c) => a + compValue_(c), 0);
      const valM = meta.maleCodes.reduce((a, c) => a + compValue_(c), 0);
      const totalVal = round2_(valF + valM);
      const keptVal = round2_((useF ? valF : 0) + (useM ? valM : 0));
      need_(totalVal > 0 && keptVal > 0,
        '"' + meta.name + '" can\'t be part-booked because its components are not individually priced on the partner\'s rate card. ' +
        'Switch Booking Type to Couple to book the full package, or ask the DCP Admin to add component prices.');
      prorate = Math.min(1, keptVal / totalVal);
    }

    const headerTag = useF && useM ? 'B' : useF ? fTag : useM ? mTag : 'P';
    const k = code + '|' + headerTag;
    need_(!seen[k], '"' + meta.name + '" is already on this lead.');
    seen[k] = 1;
    const header = base(meta, headerTag);
    if (prorate < 1) {
      header.FrozenMRP = round2_(num_(header.FrozenMRP) * prorate);
      header.FrozenPatientPrice = round2_(num_(header.FrozenPatientPrice) * prorate);
      header.FrozenMarginRs = round2_(num_(header.FrozenMarginRs) * prorate);
      header.PartnerShareRs = round2_(num_(header.FrozenPatientPrice) - num_(header.FrozenMarginRs));
      warnings.push('"' + meta.name + '" priced at ' + inr_(header.FrozenPatientPrice) + ' — ' + Math.round(prorate * 100) +
        '% of the full package, for the components actually booked.');
    }
    const comps = [];
    const addComp = function (tcode, tag) {
      const t = test_(tcode);
      comps.push({
        LeadTestID: '', LeadID: lead.LeadID, PersonTag: tag, ItemType: 'PackageComponent', ItemCode: code + ':' + tcode,
        ItemName: meta.name + ' › ' + (t ? str_(t.Name) : tcode), FrozenMRP: 0, FrozenPatientPrice: 0, FrozenMarginRs: 0,
        PartnerShareRs: 0, ScansRequired: t ? Math.max(1, num_(t.ScansRequired) || 1) : 1, ScansDone: 0, IsDone: false,
        DoneAt: '', AddedByRole: ctx.role, AddedAt: now, Active: true,
        RateCardID: meta.rateCardId, RateCardVersion: meta.version
      });
    };
    if (useF) meta.femaleCodes.forEach(c => addComp(c, fTag));
    if (useM) meta.maleCodes.forEach(c => addComp(c, mTag));
    header.ScansRequired = comps.length ? 0 : 1; // packages without a component list are completed as one line
    out.push(header);
    comps.forEach(c => out.push(c));
  });
  return { lines: out, warnings: warnings };
}

function assignLineIds_(lines) { lines.forEach(l => { if (!l.LeadTestID) l.LeadTestID = nextId_(SH.LEADTESTS, 'LeadTestID', 'LT-', 5); }); }

/** Recomputes parent lead totals from active priced lines (BRD §6.1). */
function recomputeTotals_(lead, lines) {
  const act = lines.filter(l => bool_(l.Active));
  const priced = act.filter(l => str_(l.ItemType) !== 'PackageComponent');
  const sum = k => round2_(priced.reduce((a, l) => a + num_(l[k]), 0));
  lead.ExpectedMRP = sum('FrozenMRP');
  lead.ExpectedPatientPrice = sum('FrozenPatientPrice');
  lead.ExpectedMarginRs = sum('FrozenMarginRs');
  lead.PatientDiscountRs = round2_(lead.ExpectedMRP - lead.ExpectedPatientPrice);
  const multi = act.filter(l => num_(l.ScansRequired) > 1);
  lead.ScansTotal = multi.reduce((a, l) => a + num_(l.ScansRequired), 0);
  lead.ScansCompleted = multi.reduce((a, l) => a + Math.min(num_(l.ScansDone), num_(l.ScansRequired)), 0);
}

/** Keeps package header IsDone in sync with its components. Returns changed headers. */
function syncPackageHeaders_(lines) {
  const act = lines.filter(l => bool_(l.Active)), changed = [], now = nowIST_();
  act.filter(l => str_(l.ItemType) === 'Package').forEach(h => {
    const pre = str_(h.ItemCode) + ':';
    const comps = act.filter(l => str_(l.ItemType) === 'PackageComponent' && str_(l.ItemCode).indexOf(pre) === 0);
    if (!comps.length) return;
    const done = comps.every(l => bool_(l.IsDone));
    if (done !== bool_(h.IsDone)) { h.IsDone = done; h.DoneAt = done ? now : ''; changed.push(h); }
  });
  return changed;
}

function pendingLines_(lines) { return workLines_(lines).filter(l => !bool_(l.IsDone)); }
function allLinesDone_(lines) { const w = workLines_(lines); return w.length > 0 && w.every(l => bool_(l.IsDone)); }
function personsOf_(lead) { return str_(lead.BookingType) === 'Couple' ? ['P', 'S'] : ['P']; }
function activeReports_(leadId) { return leadReports_(leadId).filter(r => bool_(r.Active)); }
function missingReportPersons_(lead) {
  const reps = activeReports_(lead.LeadID);
  return personsOf_(lead).filter(p => !reps.some(r => str_(r.PersonTag) === p || str_(r.PersonTag) === 'B'));
}
function testList_(lines) {
  const act = lines.filter(l => bool_(l.Active) && str_(l.ItemType) !== 'PackageComponent');
  return uniq_(act.map(l => str_(l.ItemName))).join(', ');
}

/* ---------- duplicates (BRD §14) ---------- */
function expandedCodes_(lines) {
  const codes = [];
  lines.filter(l => bool_(l.Active)).forEach(l => {
    const t = str_(l.ItemType), c = str_(l.ItemCode);
    if (t === 'PackageComponent') codes.push(c.split(':')[1]);
    else if (t === 'Package') {
      codes.push(c);
      const pk = package_(c);
      if (pk) splitList_(pk.FemaleTestCodes).concat(splitList_(pk.MaleTestCodes)).forEach(x => codes.push(x));
    } else codes.push(c);
  });
  return uniq_(codes);
}
function codeName_(code) { const t = test_(code); if (t) return str_(t.Name); const p = package_(code); return p ? str_(p.Name) : code; }

function findDuplicates_(phone, codes, excludeLeadId, refDateStr) {
  const win = cfgNum_('DUPLICATE_WINDOW_DAYS');
  const ref = parseDT_(refDateStr) || new Date();
  const out = [];
  DB.rows(SH.LEADS).forEach(l => {
    if (str_(l.Phone) !== phone || str_(l.LeadID) === str_(excludeLeadId)) return;
    const d = parseDT_(l.CreatedAt);
    if (!d) return;
    const days = Math.abs(ref.getTime() - d.getTime()) / 86400000;
    if (days > win) return;
    const theirs = expandedCodes_(leadLines_(l.LeadID));
    const overlap = codes.filter(c => theirs.indexOf(c) >= 0);
    if (overlap.length) out.push({ lead: l, overlap: overlap, days: Math.round(days) });
  });
  return out;
}

/** Pre-submit duplicate warning for the capture form. */
function dupCheck_(ctx, p) {
  const phone = cleanPhone_(p.phone);
  if (!RE_PHONE.test(phone)) return { matches: [] };
  const c = clinic_(str_(p.clinicId) || ctx.clinicIds[0]);
  if (!c) return { matches: [] };
  const route = routeForClinic_(c);
  const codes = [];
  if (!route.error) {
    const rc = activeRateCard_(route.partnerId);
    (p.codes || []).forEach(code => {
      codes.push(code);
      if (rc[code]) { const m = itemMeta_(rc[code]); m.femaleCodes.concat(m.maleCodes).forEach(x => codes.push(x)); }
    });
  }
  const matches = findDuplicates_(phone, uniq_(codes), '', nowIST_()).map(d => ({
    leadId: d.lead.LeadID, clinic: clinicName_(d.lead.ClinicID), created: str_(d.lead.CreatedAt).slice(0, 10),
    status: d.lead.Status, overlapping: d.overlap.map(codeName_).join(', ')
  }));
  return { matches: matches, windowDays: cfgNum_('DUPLICATE_WINDOW_DAYS') };
}

/* ---------- capture ---------- */
function createLead_(ctx, p) {
  const clinicId = str_(p.clinicId) || (ctx.role === ROLE.CM ? ctx.clinicIds[0] : '');
  need_(clinicId, 'Select the clinic.');
  need_(inClinicScope_(ctx, clinicId), 'You can only capture leads for your own clinic.');
  const c = clinic_(clinicId);
  need_(c, 'Clinic not found.');
  need_(str_(c.Status) === 'Active', c.Name + ' is ' + (str_(c.Status) || 'not active') + ' — new leads can\'t be captured. Open leads continue as usual.');
  const route = routeForClinic_(c);
  if (route.error) fail_(route.error);
  need_(p.consent === true, 'Patient consent (DPDP) must be confirmed before submitting.');
  const pat = validatePatient_(p, c);
  need_(Array.isArray(p.items) && p.items.length, 'Select at least one recommended test or package.');

  const now = nowIST_();
  const yymmdd = Utilities.formatDate(new Date(), TZ, 'yyMMdd');
  const lead = {
    LeadID: nextId_(SH.LEADS, 'LeadID', 'GYN-' + yymmdd + '-', 4), LegacyCRMLeadID: '', CreatedAt: now,
    ClinicID: clinicId, PartnerID: route.partnerId, AssignedLabID: '',
    PatientName: pat.PatientName, Gender: pat.Gender, Age: pat.Age, Phone: pat.Phone, Pincode: pat.Pincode,
    BookingType: pat.BookingType, SpouseName: pat.SpouseName, SpouseAge: pat.SpouseAge, SpouseGender: pat.SpouseGender,
    ReferringDoctor: pat.ReferringDoctor, Urgency: pat.Urgency, PreferredMode: pat.PreferredMode, BookingMode: '',
    ApptDate: '', ApptSlot: '', CollectionAddress: '', NotesForLab: pat.NotesForLab,
    ConsentTicked: true, ConsentBy: ctx.name, ConsentAt: now, Status: ST.GEN,
    FollowUpCategory: '', FollowUpDate: '', FollowUpReason: '', CancelReason: '', NotReachableReason: '', RetryAt: '',
    SampleCollectedAt: '', ScansCompleted: 0, ScansTotal: 0, TestDoneAt: '', PaymentAmount: '', PaymentMode: '',
    PaymentDate: '', PaymentRef: '', RevenueState: REV.EXPECTED, ReportGeneratedAt: '', ClosedAt: '', OptOut: false,
    LastUpdatedAt: now, LastUpdatedBy: ctx.name, StatusChangedAt: now, NextScanDate: ''
  };
  const rc = activeRateCard_(route.partnerId);
  const built = buildLines_(ctx, lead, p.items, rc, { clinicOnly: true });
  const lines = built.lines, warnings = built.warnings.slice();
  recomputeTotals_(lead, lines);
  need_(num_(lead.ExpectedPatientPrice) > 0, 'Select at least one priced test or package (₹0 leads are blocked).');
  if (lead.PreferredMode === 'Home collection' && lines.some(l => str_(l.ItemType) !== 'PackageComponent' && !itemHomeAllowed_(lead.PartnerID, l))) {
    lead.PreferredMode = 'Lab visit';
    warnings.push('Preferred mode set to Lab visit — one or more selected items (scans/imaging) can\'t be done by home collection.');
  }
  const dupes = findDuplicates_(lead.Phone, expandedCodes_(lines), '', now);
  if (dupes.length && p.acknowledgeDuplicate !== true) {
    fail_('This phone already has a lead with an overlapping test in the last ' + cfgNum_('DUPLICATE_WINDOW_DAYS') +
      ' days (' + dupes.map(d => d.lead.LeadID).join(', ') + '). Review the warning and submit again to continue.', 'DUPLICATE_WARNING');
  }

  assignLineIds_(lines);
  DB.insert(SH.LEADS, lead);
  DB.insert(SH.LEADTESTS, lines);
  resetGroups_();

  if (dupes.length) {
    DB.insert(SH.DUPES, dupes.map(d => {
      const older = parseDT_(d.lead.CreatedAt) <= parseDT_(now);
      return {
        ReviewID: nextId_(SH.DUPES, 'ReviewID', 'DUP-', 3), DetectedAt: now,
        PrimaryLeadID: older ? d.lead.LeadID : lead.LeadID, DuplicateLeadID: older ? lead.LeadID : d.lead.LeadID,
        PatientName: lead.PatientName, Phone: lead.Phone, Clinic1: d.lead.ClinicID, Clinic2: lead.ClinicID,
        OverlappingTests: d.overlap.map(codeName_).join(' | '), DaysApart: d.days, ResolutionStatus: 'Pending Admin Review',
        ResolvedBy: '', ResolutionNote: 'Auto-detected at capture: same phone + overlapping test within ' + cfgNum_('DUPLICATE_WINDOW_DAYS') + ' days'
      };
    }));
  }
  audit_(ctx, 'LEAD_CREATED', lead.LeadID, 'Lead', lead.LeadID, null,
    pick_(lead, ['ClinicID', 'PartnerID', 'BookingType', 'Urgency', 'ExpectedMRP', 'ExpectedPatientPrice', 'ExpectedMarginRs']),
    'Tests: ' + testList_(lines) + (dupes.length ? ' · duplicate warning acknowledged' : ''));

  notifyCoordinatorsNewLead_(lead, lines);
  const labAlerts = notifyLabManagersNewLead_(lead, lines);
  const m1 = messageForLead_(ctx, 'M1', lead, lines);
  autoSendIfApi_(ctx, 'M1', lead, lines);
  return {
    leadId: lead.LeadID, partner: partnerName_(lead.PartnerID), patientPrice: lead.ExpectedPatientPrice,
    mrp: lead.ExpectedMRP, warnings: warnings, duplicates: dupes.map(d => d.lead.LeadID), m1: m1, labAlerts: labAlerts
  };
}

function itemHomeAllowed_(partnerId, line) {
  const code = str_(line.ItemCode);
  if (str_(line.ItemType) === 'PackageComponent') return testHomeAllowed_(code.split(':')[1]) && !isImagingTest_(code.split(':')[1]);
  const rc = activeRateCard_(partnerId)[code];
  if (rc) return itemMeta_(rc).home;
  if (str_(line.ItemType) === 'Package') { const pk = package_(code); return pk ? !bool_(pk.IncludesScans) : false; }
  return testHomeAllowed_(code) && !isImagingTest_(code);
}
function leadHasImaging_(lines) {
  return lines.filter(l => bool_(l.Active)).some(l => {
    const t = str_(l.ItemType), c = str_(l.ItemCode);
    if (t === 'PackageComponent') return isImagingTest_(c.split(':')[1]);
    if (t === 'Package') { const pk = package_(c); return pk ? bool_(pk.IncludesScans) || splitList_(pk.FemaleTestCodes).concat(splitList_(pk.MaleTestCodes)).some(isImagingTest_) : false; }
    return isImagingTest_(c);
  });
}

function notifyCoordinatorsNewLead_(lead, lines) {
  const to = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.PC && str_(u.OrgID) === str_(lead.PartnerID))
    .filter(u => { const cx = buildCtx_(u); return inClinicScope_(cx, lead.ClinicID); }).map(u => str_(u.Email));
  if (!to.length) return;
  const url = appUrl_();
  sendMail_(to, '[DCP] New lead ' + lead.LeadID + ' · ' + clinicName_(lead.ClinicID) + (lead.Urgency === 'Urgent' ? ' · URGENT' : ''),
    '<p>A new diagnostic referral has been routed to ' + escHtml_(partnerName_(lead.PartnerID)) + '.</p>' +
    '<p><b>Lead:</b> ' + escHtml_(lead.LeadID) + '<br><b>Clinic:</b> ' + escHtml_(clinicName_(lead.ClinicID)) +
    '<br><b>Urgency:</b> ' + escHtml_(lead.Urgency) + '<br><b>Tests:</b> ' + escHtml_(testList_(lines)) + '</p>' +
    '<p>Please call the patient within ' + cfgNum_('SLA_CALL_HOURS') + ' hours. Patient contact details are in the app' +
    (url ? ': <a href="' + escHtml_(url) + '">open DCP app</a>' : '') + '.</p>');
}

/**
 * Free (no paid WhatsApp API / Official Business Account needed) lab-side alert on lead capture.
 * Emails every distinct lab-manager contact at the routed partner's labs serving this clinic, and
 * returns one click-to-WhatsApp (wa.me) link per distinct manager for the client to open/offer.
 * Dedupes by manager mobile+email, since one partner's lab roster commonly lists many lab/branch
 * rows (per test category) that all share a single hub manager contact.
 */
function notifyLabManagersNewLead_(lead, lines) {
  const labs = activeLabsForClinic_(lead.PartnerID, lead.ClinicID);
  const seen = {}, mgrs = [];
  labs.forEach(l => {
    const mobile = cleanPhone_(l.LabManagerMobile), email = str_(l.LabManagerEmail);
    if (!mobile && !email) return;
    const key = mobile + '|' + email;
    if (seen[key]) return;
    seen[key] = 1;
    mgrs.push({ name: str_(l.LabManagerName), labName: str_(l.LabName), mobile: mobile, email: email });
  });
  if (!mgrs.length) return [];

  const emails = mgrs.map(m => m.email).filter(Boolean);
  if (emails.length) {
    const url = appUrl_();
    sendMail_(emails, '[DCP] New lead ' + lead.LeadID + ' · ' + clinicName_(lead.ClinicID) + (lead.Urgency === 'Urgent' ? ' · URGENT' : ''),
      '<p>A new diagnostic referral has been captured at ' + escHtml_(clinicName_(lead.ClinicID)) + ' for ' + escHtml_(partnerName_(lead.PartnerID)) + '.</p>' +
      '<p><b>Lead:</b> ' + escHtml_(lead.LeadID) + '<br><b>Clinic:</b> ' + escHtml_(clinicName_(lead.ClinicID)) +
      '<br><b>Urgency:</b> ' + escHtml_(lead.Urgency) + '<br><b>Tests:</b> ' + escHtml_(testList_(lines)) + '</p>' +
      '<p>Please plan lab capacity for this booking' + (url ? ': <a href="' + escHtml_(url) + '">open DCP app</a>' : '') + '.</p>');
  }

  const text = 'DCP Alert: New lead ' + lead.LeadID + ' at ' + clinicName_(lead.ClinicID) +
    (lead.Urgency === 'Urgent' ? ' (URGENT)' : '') + '. Tests: ' + testList_(lines) + '. Please plan lab capacity.';
  return mgrs.filter(m => m.mobile).map(m => ({ name: m.name, labName: m.labName, link: waLink_(m.mobile, text) }));
}

/* ---------- SLA (BRD §4.5) ---------- */
function reportTatHours_(lead, lines) {
  const rc = activeRateCard_(lead.PartnerID);
  let max = 0;
  lines.filter(l => bool_(l.Active)).forEach(l => {
    const t = str_(l.ItemType), c = str_(l.ItemCode);
    let tat = 0;
    if (t === 'PackageComponent') { const ts = test_(c.split(':')[1]); tat = ts ? num_(ts.DefaultTATHours) : 0; }
    else { tat = rc[c] ? num_(rc[c].TATHours) : 0; if (!tat) { const ts = test_(c); tat = ts ? num_(ts.DefaultTATHours) : 0; } }
    max = Math.max(max, tat);
  });
  return max || 24;
}

function slaInfo_(lead, lines, now) {
  now = now || new Date();
  const s = str_(lead.Status), today = fmtD_(now);
  const r = { stage: '', hours: null, target: null, breached: false, warn: false, priority: false, paused: false, due: false, label: '' };
  const since = v => hoursSince_(v, now);
  const changed = lead.StatusChangedAt || lead.LastUpdatedAt || lead.CreatedAt;
  const fu = str_(lead.FollowUpDate).slice(0, 10);
  const setTimer = (stage, h, target) => {
    r.stage = stage; r.hours = h === null ? null : Math.round(h * 10) / 10; r.target = target;
    if (h !== null) { r.breached = h > target; r.warn = !r.breached && h > target * 0.75; }
  };
  if (s === ST.GEN) {
    const h = since(lead.CreatedAt);
    setTimer('Call', h, cfgNum_('SLA_CALL_HOURS'));
    r.warn = h !== null && h >= cfgNum_('SLA_CALL_WARN_HOURS');
    r.priority = h !== null && h >= cfgNum_('SLA_CALL_PRIORITY_HOURS');
  } else if (s === ST.CALLED) {
    if (fu && fu > today) { r.paused = true; r.stage = 'Follow-up'; r.label = 'Follow-up on ' + fu; return r; }
    if (fu && fu <= today) r.due = true;
    setTimer('Booking', since(changed), cfgNum_('SLA_BOOKING_HOURS'));
  } else if (s === ST.BOOKED) {
    setTimer('Scheduling', since(changed), cfgNum_('SLA_SCHEDULE_HOURS'));
  } else if (s === ST.SAMPLE) {
    setTimer('Test done', since(lead.SampleCollectedAt || changed), cfgNum_('SLA_TEST_DONE_DAYS') * 24);
  } else if (s === ST.DONE) {
    setTimer('Report', since(lead.TestDoneAt || changed), reportTatHours_(lead, lines));
  } else if (FOLLOWUP_ST.indexOf(s) >= 0) {
    r.paused = true; r.stage = 'Follow-up';
    r.due = !!fu && fu <= today;
    r.label = r.due ? 'Follow-up due' : (fu ? 'Follow-up on ' + fu : 'Follow-up');
    return r;
  } else if (s === ST.NR) {
    r.stage = 'Retry';
    const ra = parseDT_(lead.RetryAt);
    r.due = !ra || ra <= now;
    const age = since(lead.CreatedAt);
    r.escalate = (age !== null && age > cfgNum_('UNREACHABLE_CANCEL_DAYS') * 24) || str_(lead.NotReachableReason) === 'Wrong number';
    r.label = r.escalate ? 'Escalate to Admin' : (r.due ? 'Retry due' : 'Retry ' + str_(lead.RetryAt));
    return r;
  } else if (SCHEDULED_ST.indexOf(s) >= 0) {
    const ad = str_(lead.ApptDate).slice(0, 10);
    r.stage = 'Appointment';
    if (ad && ad < today) { r.warn = true; r.label = 'Appointment date passed (' + ad + ')'; }
    else r.label = ad ? 'Appt ' + ad + ' ' + str_(lead.ApptSlot) : '';
    return r;
  }
  if (r.stage && r.hours !== null) {
    r.label = r.breached ? (r.stage === 'Report' ? 'Report overdue' : r.stage + ' SLA breached') + ' · ' + Math.round(r.hours) + 'h / ' + r.target + 'h'
      : r.stage + ' ' + Math.round(r.hours) + 'h / ' + r.target + 'h';
  }
  return r;
}

/* ---------- role-based field filtering (BRD §2.4, §6.5) ---------- */
const MARGIN_FIELDS = ['ExpectedMarginRs', 'RevenueState'];
const MONEY_FIELDS_LAB = ['ExpectedMRP', 'PatientDiscountRs', 'PaymentAmount', 'PaymentMode', 'PaymentDate', 'PaymentRef'];
function sanitizeLead_(ctx, lead) {
  const o = clone_(lead);
  if (ctx.role !== ROLE.ADMIN) MARGIN_FIELDS.forEach(k => delete o[k]);
  if (ctx.role === ROLE.LAB) MONEY_FIELDS_LAB.forEach(k => delete o[k]);
  return o;
}
function sanitizeLine_(ctx, l) {
  const o = clone_(l);
  if (ctx.role !== ROLE.ADMIN) { delete o.FrozenMarginRs; delete o.PartnerShareRs; }
  if (ctx.role === ROLE.LAB) delete o.FrozenMRP;
  o.IsDone = bool_(l.IsDone); o.Active = bool_(l.Active);
  return o;
}

/* ---------- queue summaries ---------- */
function queuesFor_(lead, sla, today) {
  const s = str_(lead.Status), q = [], fu = str_(lead.FollowUpDate).slice(0, 10);
  if (s === ST.GEN) q.push('new');
  if (s === ST.NR) q.push(sla.due ? 'retry' : 'waiting');
  if (FOLLOWUP_ST.indexOf(s) >= 0 || (s === ST.CALLED && fu)) q.push(fu && fu <= today ? 'followup' : 'waiting');
  if (s === ST.CALLED && !(fu && fu > today)) q.push('tobook');
  if (s === ST.BOOKED) q.push('toschedule');
  if (SCHEDULED_ST.indexOf(s) >= 0) q.push('scheduled');
  if (s === ST.SAMPLE) q.push('inprogress');
  if (s === ST.DONE) q.push('awaitreport');
  if (s === ST.DISPUTED) q.push('disputed');
  if (sla.breached) q.push('overdue');
  if (sla.escalate) q.push('escalation');
  return q;
}

function leadSummary_(ctx, l, now) {
  const lines = leadLines_(l.LeadID);
  const sla = slaInfo_(l, lines, now);
  const today = fmtD_(now);
  const work = workLines_(lines);
  const pend = work.filter(x => !bool_(x.IsDone));
  const s = {
    id: l.LeadID, legacy: str_(l.LegacyCRMLeadID), created: str_(l.CreatedAt), clinicId: str_(l.ClinicID),
    clinic: clinicName_(l.ClinicID), partnerId: str_(l.PartnerID), labId: str_(l.AssignedLabID),
    lab: l.AssignedLabID ? labName_(l.AssignedLabID) : '', name: str_(l.PatientName), phone: str_(l.Phone),
    gender: str_(l.Gender), age: l.Age, booking: str_(l.BookingType), spouse: str_(l.SpouseName),
    urgency: str_(l.Urgency) || 'Normal', status: str_(l.Status), fuDate: str_(l.FollowUpDate).slice(0, 10),
    fuCat: str_(l.FollowUpCategory), retryAt: str_(l.RetryAt), nrReason: str_(l.NotReachableReason),
    appt: str_(l.ApptDate).slice(0, 10), slot: str_(l.ApptSlot), mode: str_(l.BookingMode), pincode: str_(l.Pincode),
    tests: testList_(lines), pending: pend.length, work: work.length,
    scans: num_(l.ScansTotal) ? num_(l.ScansCompleted) + '/' + num_(l.ScansTotal) : '',
    sla: sla, queues: queuesFor_(l, sla, today), optOut: bool_(l.OptOut), updated: str_(l.LastUpdatedAt),
    reports: activeReports_(l.LeadID).length, doctor: str_(l.ReferringDoctor)
  };
  s.price = num_(l.ExpectedPatientPrice); // patient payable is visible to all roles (lab collects it at the counter)
  if (ctx.role !== ROLE.LAB) s.mrp = num_(l.ExpectedMRP);
  if (ctx.role === ROLE.ADMIN) { s.margin = num_(l.ExpectedMarginRs); s.rev = str_(l.RevenueState); }
  if (str_(l.Status) === ST.DONE && !str_(l.PaymentMode) && ctx.role !== ROLE.LAB) s.paymentPending = true;
  if (s.tests.length > 90) s.tests = s.tests.slice(0, 88) + '…';
  s.sla = compact_({ label: sla.label, breached: sla.breached, warn: sla.warn, priority: sla.priority, due: sla.due, escalate: sla.escalate, paused: sla.paused, hours: sla.breached ? sla.hours : null });
  delete s.updated; // partnerId is kept — needed for Queue/Search filtering (BRD §9.1)
  return compact_(s);
}
/** Drops empty values to keep queue payloads small (client treats missing as empty). */
function compact_(o) {
  Object.keys(o).forEach(k => { const v = o[k]; if (v === '' || v === null || v === undefined || v === false || (Array.isArray(v) && !v.length)) delete o[k]; });
  return o;
}

/** Leads in the caller's scope. Terminal leads older than 30 days are left to search. */
function leadsInScope_(ctx, opts) {
  opts = opts || {};
  const cutoff = fmtD_(new Date(Date.now() - (opts.terminalDays || 30) * 86400000));
  return DB.rows(SH.LEADS).filter(l => {
    if (!canSeeLead_(ctx, l)) return false;
    if (opts.all) return true;
    const s = str_(l.Status);
    if (TERMINAL_ST.indexOf(s) >= 0 || s === ST.REPORT) return str_(l.LastUpdatedAt).slice(0, 10) >= cutoff;
    return true;
  });
}

function queue_(ctx, p) {
  const now = new Date();
  const leads = leadsInScope_(ctx, {});
  const items = leads.map(l => leadSummary_(ctx, l, now));
  const counts = {};
  items.forEach(i => (i.queues || []).forEach(q => { counts[q] = (counts[q] || 0) + 1; }));
  counts.all = items.length;
  const tab = str_(p && p.tab);
  let shown = tab && tab !== 'all' ? items.filter(i => (i.queues || []).indexOf(tab) >= 0) : items;
  // Priority order: urgent & breached first, then soonest due, then oldest.
  const dueKey = i => i.retryAt || i.fuDate || i.appt || i.created || '';
  shown.sort((a, b) => ((b.urgency === 'Urgent') - (a.urgency === 'Urgent')) || ((b.sla && b.sla.breached ? 1 : 0) - (a.sla && a.sla.breached ? 1 : 0)) ||
    dueKey(a).localeCompare(dueKey(b)));
  const limit = Math.max(50, Math.min(Number(p && p.limit) || 400, 2000));
  const total = shown.length;
  shown = shown.slice(0, limit);
  return { items: shown, tab: tab || 'all', total: total, truncated: total > shown.length, counts: counts,
    serverTime: fmtDT_(now), reminders: remindersDue_(ctx, leads, now).length };
}

function search_(ctx, p) {
  const q = str_(p.q).toLowerCase(), now = new Date();
  const from = str_(p.from), to = str_(p.to);
  const res = DB.rows(SH.LEADS).filter(l => {
    if (!canSeeLead_(ctx, l)) return false;
    if (p.status && str_(l.Status) !== p.status) return false;
    if (p.clinicId && str_(l.ClinicID) !== p.clinicId) return false;
    if (p.partnerId && str_(l.PartnerID) !== p.partnerId) return false;
    if (p.labId && str_(l.AssignedLabID) !== p.labId) return false;
    if (p.urgency && (str_(l.Urgency) || 'Normal') !== p.urgency) return false;
    if (p.regionId || p.areaId) {
      const cl = clinic_(l.ClinicID);
      if (p.regionId && (!cl || str_(cl.RegionID) !== p.regionId)) return false;
      if (p.areaId && (!cl || str_(cl.AreaID) !== p.areaId)) return false;
    }
    const c = str_(l.CreatedAt).slice(0, 10);
    if (from && c < from) return false;
    if (to && c > to) return false;
    if (!q) return true;
    return [l.LeadID, l.LegacyCRMLeadID, l.PatientName, l.Phone, l.SpouseName].some(v => str_(v).toLowerCase().indexOf(q) >= 0);
  });
  res.sort((a, b) => str_(b.CreatedAt).localeCompare(str_(a.CreatedAt)));
  return { items: res.slice(0, 500).map(l => leadSummary_(ctx, l, now)), total: res.length };
}
/* ============================================================================
 *  WORKFLOW — status transitions (BRD §4), scheduling & lab selection (§5.5),
 *  progress / multi-scan (§3.3), test edits & re-pricing (§6.2), payment (§6.4)
 * ==========================================================================*/

/* ---------- lab capability ---------- */
function labTokens_(lab) { return splitList_(lab.TestsPerformed).map(s => s.toUpperCase()); }
function labPerforms_(lab, testCode) {
  const tk = labTokens_(lab);
  if (tk.indexOf(str_(testCode).toUpperCase()) >= 0 || tk.indexOf('ALL') >= 0) return true;
  if (isImagingTest_(testCode)) return tk.indexOf('ALL_RADIOLOGY_USG') >= 0 || tk.indexOf('ALL_IMAGING') >= 0;
  return tk.indexOf('ALL_PATHOLOGY') >= 0 || tk.indexOf('ALL_PATHOLOGY_ONLY') >= 0;
}
function leadTestCodes_(lines) {
  const codes = [];
  lines.filter(l => bool_(l.Active)).forEach(l => {
    const t = str_(l.ItemType), c = str_(l.ItemCode);
    if (t === 'PackageComponent') codes.push(c.split(':')[1]);
    else if (t === 'Package') {
      const pre = c + ':';
      if (!lines.some(x => bool_(x.Active) && str_(x.ItemCode).indexOf(pre) === 0)) {
        const pk = package_(c);
        if (pk) splitList_(pk.FemaleTestCodes).concat(splitList_(pk.MaleTestCodes)).forEach(x => codes.push(x));
      }
    } else codes.push(c);
  });
  return uniq_(codes);
}
function labMissingTests_(lab, lines) { return leadTestCodes_(lines).filter(c => !labPerforms_(lab, c)).map(codeName_); }
function labHomePins_(lab) { return str_(lab.HomeCollectionPincodes).split(/[,;|\s]+/).map(s => s.trim()).filter(Boolean); }
function labSupportsHome_(lab, pincode) {
  const modes = str_(lab.Modes).toLowerCase();
  if (!(modes === 'both' || modes.indexOf('home') >= 0)) return false;
  const pins = labHomePins_(lab);
  return pins.indexOf(str_(pincode)) >= 0 || pins.some(x => x.toUpperCase() === 'ALL');
}
function labSupportsVisit_(lab) { const m = str_(lab.Modes).toLowerCase(); return m === 'both' || m.indexOf('lab') >= 0 || !m; }
function homeBlockedItems_(lead, lines) {
  return lines.filter(l => bool_(l.Active) && !itemHomeAllowed_(lead.PartnerID, l)).map(l => str_(l.ItemName));
}

/** Lab picker (BRD §5.5): partner's Active labs, clinic-mapped first, then nearest pincode. */
function labOptions_(lead, lines, mode) {
  const pin = Number(lead.Pincode) || 0;
  return DB.where(SH.LABS, l => str_(l.PartnerID) === str_(lead.PartnerID) && str_(l.State) === 'Active').map(l => {
    const missing = labMissingTests_(l, lines);
    const serves = splitList_(l.ClinicIDServed).indexOf(str_(lead.ClinicID)) >= 0;
    const home = labSupportsHome_(l, lead.Pincode);
    let ok = !missing.length, why = missing.length ? 'Doesn\'t perform: ' + missing.join(', ') : '';
    if (mode === 'home' && ok && !home) { ok = false; why = 'No home collection for pincode ' + lead.Pincode; }
    if (mode === 'visit' && ok && !labSupportsVisit_(l)) { ok = false; why = 'Home collection only'; }
    return {
      labId: str_(l.LabID), name: str_(l.LabName), area: str_(l.AreaName), address: str_(l.Address), pincode: str_(l.Pincode),
      phone: str_(l.LabPhone), maps: str_(l.MapsLink), serves: serves, home: home, ok: ok, why: why,
      dist: Math.abs((Number(l.Pincode) || 0) - pin)
    };
  }).sort((a, b) => (b.ok - a.ok) || (b.serves - a.serves) || (a.dist - b.dist) || a.name.localeCompare(b.name));
}

function validateSchedule_(lead, lines, p, toStatus) {
  const lab = lab_(p.labId);
  need_(lab, 'Select the fulfilling lab.');
  need_(str_(lab.PartnerID) === str_(lead.PartnerID), 'The selected lab belongs to a different partner.');
  need_(str_(lab.State) === 'Active', lab.LabName + ' is not Active yet.');
  const missing = labMissingTests_(lab, lines);
  need_(!missing.length, lab.LabName + ' doesn\'t perform: ' + missing.join(', ') + '. Pick another lab.');
  const today = todayIST_();
  need_(isValidDateStr_(p.apptDate), 'Enter the appointment date.');
  need_(p.apptDate >= today, 'Appointment date can\'t be in the past.');
  const slot = str_(p.apptSlot);
  need_(slot.length >= 3 && slot.length <= 40, 'Enter the appointment time / slot (e.g. 10:30 or 10:00–11:00).');
  const out = { AssignedLabID: str_(lab.LabID), ApptDate: p.apptDate, ApptSlot: slot };
  if (toStatus === ST.HOME) {
    const blocked = homeBlockedItems_(lead, lines);
    need_(!blocked.length, 'Home collection isn\'t allowed for: ' + blocked.join(', ') + '. Schedule a Lab visit instead.');
    need_(labSupportsHome_(lab, lead.Pincode), lab.LabName + ' doesn\'t offer home collection for pincode ' + lead.Pincode + '.');
    const addr = str_(p.collectionAddress);
    need_(addr.length >= 10, 'Enter the full home-collection address.');
    out.CollectionAddress = addr.slice(0, 300);
    out.BookingMode = 'Home collection';
  } else {
    need_(labSupportsVisit_(lab), lab.LabName + ' is a home-collection-only centre.');
    out.BookingMode = 'Lab visit';
  }
  return out;
}

/* ---------- payment ---------- */
function validatePayment_(lead, p, required) {
  const has = p.paymentAmount !== undefined && p.paymentAmount !== null && str_(p.paymentAmount) !== '';
  if (!has && !required) return null;
  const amt = Number(p.paymentAmount);
  need_(has && isFinite(amt) && amt >= 0, 'Enter the amount the patient paid (₹).');
  need_(REASONS.PAYMENT_MODES.indexOf(str_(p.paymentMode)) >= 0, 'Select the payment mode.');
  need_(isValidDateStr_(p.paymentDate), 'Enter the payment date.');
  const booking = str_(lead.CreatedAt).slice(0, 10);
  need_(p.paymentDate >= booking, 'Payment date can\'t be before the booking date (' + booking + ').');
  need_(p.paymentDate <= todayIST_(), 'Payment date can\'t be in the future.');
  return { PaymentAmount: round2_(amt), PaymentMode: str_(p.paymentMode), PaymentDate: p.paymentDate, PaymentRef: str_(p.paymentRef).slice(0, 60) };
}

/* ---------- transition guards ---------- */
function transitionGuard_(ctx, lead, to, lines) {
  const from = str_(lead.Status);
  lines = lines || leadLines_(lead.LeadID);
  if ((from === ST.NI || from === ST.CANCEL) && (to === ST.CALLED || to === ST.BOOKED)) {
    const age = hoursSince_(lead.StatusChangedAt || lead.LastUpdatedAt);
    const win = cfgNum_('ADMIN_REOPEN_WINDOW_DAYS');
    if (age !== null && age > win * 24) return 'Reopen window (' + win + ' days) has passed.';
    if (to === ST.BOOKED && !workLines_(lines).length) return 'No active tests on this lead.';
  }
  if (from === ST.NR && to === ST.CANCEL) {
    const age = hoursSince_(lead.CreatedAt);
    const days = cfgNum_('UNREACHABLE_CANCEL_DAYS');
    if (str_(lead.NotReachableReason) !== 'Wrong number' && age !== null && age < days * 24)
      return 'Admin can cancel an unreachable lead after ' + days + ' days (or immediately if "Wrong number").';
  }
  if (to === ST.BOOKED && !workLines_(lines).length) return 'Add at least one test before booking.';
  if (to === ST.HOME) {
    const blocked = homeBlockedItems_(lead, lines);
    if (blocked.length) return 'Home collection not allowed for: ' + blocked.join(', ');
  }
  if (to === ST.SAMPLE) return 'Use "Log progress" to mark samples collected / scans done.';
  if (to === ST.DONE && from !== ST.DISPUTED) {
    const pend = pendingLines_(lines);
    if (pend.length) return 'Pending: ' + pend.map(l => str_(l.ItemName) + (num_(l.ScansRequired) > 1 ? ' (' + num_(l.ScansDone) + '/' + num_(l.ScansRequired) + ')' : '')).join(', ');
  }
  if (to === ST.REPORT) {
    const miss = missingReportPersons_(lead);
    if (miss.length) return 'Upload a report PDF for: ' + miss.map(personLabel_).join(' and ');
  }
  if (to === ST.CLOSED) {
    if (missingReportPersons_(lead).length) return 'An active report PDF is required for every person.';
    if (str_(lead.RevenueState) !== REV.COLLECTED) return 'Commission must be Collected (settled via partner transfer) before closing.';
  }
  return '';
}

function availableTransitions_(ctx, lead, lines) {
  const from = str_(lead.Status);
  return TRANSITIONS.filter(t => t[0] === from && roleCodeAllows_(t[2], ctx.role)).map(t => {
    const why = transitionGuard_(ctx, lead, t[1], lines);
    return { to: t[1], allowed: !why, reason: why };
  });
}

/* ---------- the transition ---------- */
function transition_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const from = str_(lead.Status), to = str_(p.to);
  const t = TRANSITIONS.find(x => x[0] === from && x[1] === to);
  need_(t, 'A lead in "' + from + '" can\'t move to "' + to + '".');
  need_(roleCodeAllows_(t[2], ctx.role), 'Your role (' + ctx.role + ') can\'t move a lead from "' + from + '" to "' + to + '".');
  if (p.expectedStatus) need_(p.expectedStatus === from, 'This lead was just updated by someone else (now "' + from + '"). Refresh and try again.');
  const lines = leadLines_(lead.LeadID);
  const guard = transitionGuard_(ctx, lead, to, lines);
  need_(!guard, guard);

  const before = clone_(lead);
  const now = nowIST_(), today = todayIST_();
  let note = str_(p.note).slice(0, 1000), msg = null, extraMsgCode = null;

  switch (to) {
    case ST.CALLED: {
      need_(note.length >= 3, 'Add a short call summary.');
      lead.FollowUpCategory = ''; lead.FollowUpDate = ''; lead.FollowUpReason = '';
      if (from === ST.NI || from === ST.CANCEL) { lead.RevenueState = REV.EXPECTED; lead.CancelReason = ''; }
      break;
    }
    case ST.NR: {
      need_(REASONS.NOT_REACHABLE.indexOf(str_(p.reason)) >= 0, 'Select why the patient was not reachable.');
      need_(isValidDTStr_(p.retryAt), 'Enter the retry date and time.');
      need_(parseDT_(p.retryAt) > new Date(), 'Retry time must be in the future.');
      lead.NotReachableReason = p.reason; lead.RetryAt = str_(p.retryAt).replace('T', ' ');
      break;
    }
    case ST.BOOKED: {
      if (from === ST.NI || from === ST.CANCEL) { lead.RevenueState = REV.EXPECTED; lead.CancelReason = ''; }
      lead.FollowUpCategory = ''; lead.FollowUpDate = ''; lead.FollowUpReason = '';
      break;
    }
    case ST.LABVISIT:
    case ST.HOME: {
      const wasScheduled = SCHEDULED_ST.indexOf(from) >= 0 || !!str_(lead.ApptDate);
      const s = validateSchedule_(lead, lines, p, to);
      Object.keys(s).forEach(k => { lead[k] = s[k]; });
      if (to === ST.LABVISIT) lead.CollectionAddress = '';
      lead.FollowUpCategory = ''; lead.FollowUpDate = ''; lead.FollowUpReason = '';
      extraMsgCode = wasScheduled ? 'M6' : (to === ST.HOME ? 'M3' : 'M2');
      break;
    }
    case ST.DONE: {
      if (from === ST.DISPUTED) {
        need_(note.length >= 3, 'Add a resolution note.');
        lead.RevenueState = revenueFromAllocations_(lead);
        setStatementLineStatusForLead_(lead.LeadID, 'Open', note);
      } else {
        const pay = validatePayment_(lead, p, ctx.role !== ROLE.LAB);
        if (pay) Object.keys(pay).forEach(k => { lead[k] = pay[k]; });
        lead.TestDoneAt = now;
        lead.RevenueState = REV.EARNED;
      }
      break;
    }
    case ST.REPORT: {
      lead.ReportGeneratedAt = now;
      extraMsgCode = 'M8';
      break;
    }
    case ST.NI:
    case ST.CANCEL: {
      const r = str_(p.reason);
      need_(REASONS.CANCEL.indexOf(r) >= 0, 'Select a reason.');
      let reason = r;
      if (r === 'Other (text)') { need_(str_(p.reasonText).length >= 3, 'Describe the reason.'); reason = 'Other: ' + str_(p.reasonText).slice(0, 200); }
      if (r === 'Duplicate' && str_(p.primaryLeadId)) reason += ' of ' + str_(p.primaryLeadId);
      lead.CancelReason = reason;
      lead.RevenueState = REV.VOID;
      if (from === ST.DISPUTED) setStatementLineStatusForLead_(lead.LeadID, 'Void', note || reason);
      break;
    }
    case ST.FU_AP:
    case ST.FU_WDL: {
      need_(isValidDateStr_(p.followUpDate) && p.followUpDate > today, 'Follow-up date must be a future date.');
      const r = str_(p.reason);
      need_(REASONS.FOLLOWUP.indexOf(r) >= 0, 'Select a follow-up reason.');
      lead.FollowUpCategory = to; lead.FollowUpDate = p.followUpDate;
      lead.FollowUpReason = r === 'Other' && str_(p.reasonText) ? 'Other: ' + str_(p.reasonText).slice(0, 200) : r;
      break;
    }
    case ST.DISPUTED: {
      need_(note.length >= 3, 'A dispute note is mandatory.');
      lead.RevenueState = REV.FROZEN;
      setStatementLineStatusForLead_(lead.LeadID, 'Disputed', note);
      break;
    }
    case ST.CLOSED: { lead.ClosedAt = now; break; }
  }

  lead.Status = to;
  lead.StatusChangedAt = now;
  lead.LastUpdatedAt = now;
  lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  const d = diff_(before, lead);
  audit_(ctx, 'STATUS_CHANGE', lead.LeadID, 'Lead', from + ' → ' + to, d.before, d.after,
    [note, p.reason ? 'Reason: ' + p.reason : ''].filter(Boolean).join(' · '));

  if (extraMsgCode) msg = messageForLead_(ctx, extraMsgCode, lead, lines);
  if (extraMsgCode) autoSendIfApi_(ctx, extraMsgCode, lead, lines);
  if (to === ST.REPORT) notifyClinicReportReady_(lead, lines);
  return { leadId: lead.LeadID, status: lead.Status, message: msg };
}

/* ---------- progress: sample collected, scans, per-test completion ---------- */
function progress_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(roleCodeAllows_('L', ctx.role), 'Your role can\'t log test progress.');
  need_([ST.LABVISIT, ST.HOME, ST.SAMPLE].indexOf(str_(lead.Status)) >= 0, 'Progress can be logged once the appointment is scheduled (current status: ' + lead.Status + ').');
  const lines = leadLines_(lead.LeadID);
  const act = lines.filter(l => bool_(l.Active));
  const ups = Array.isArray(p.updates) ? p.updates : [];
  need_(ups.length, 'Select at least one test to update.');
  const now = nowIST_(), today = todayIST_();
  const changed = [];
  let scan = null;
  ups.forEach(u => {
    const l = act.find(x => str_(x.LeadTestID) === str_(u.leadTestId));
    need_(l, 'Test line not found on this lead.');
    need_(!isPkgHeader_(l, act), 'Package completion follows its component tests.');
    const req = Math.max(1, num_(l.ScansRequired) || 1);
    if (u.undo) {
      need_(ctx.role !== ROLE.LAB, 'Ask the Partner Coordinator to undo a completed test.');
      if (req > 1) l.ScansDone = Math.max(0, num_(l.ScansDone) - 1); else l.ScansDone = 0;
      l.IsDone = false; l.DoneAt = '';
      changed.push(l);
      return;
    }
    if (bool_(l.IsDone)) return;
    if (req > 1) {
      l.ScansDone = Math.min(req, num_(l.ScansDone) + 1);
      if (l.ScansDone >= req) { l.IsDone = true; l.DoneAt = now; }
      else {
        need_(isValidDateStr_(p.nextScanDate) && p.nextScanDate >= today,
          'Enter the next scan date for ' + l.ItemName + ' (scan ' + (l.ScansDone + 1) + ' of ' + req + ').');
        scan = { ScanNum: l.ScansDone + 1, NextScanDate: p.nextScanDate, of: req };
      }
    } else { l.IsDone = true; l.DoneAt = now; l.ScansDone = 1; }
    changed.push(l);
  });
  syncPackageHeaders_(lines).forEach(h => { if (changed.indexOf(h) < 0) changed.push(h); });
  if (changed.length) DB.updateMany(SH.LEADTESTS, changed);

  const before = clone_(lead);
  if (str_(lead.Status) !== ST.SAMPLE) {
    lead.Status = ST.SAMPLE;
    lead.StatusChangedAt = now;
    if (!str_(lead.SampleCollectedAt)) lead.SampleCollectedAt = now;
  }
  if (scan) lead.NextScanDate = scan.NextScanDate;
  recomputeTotals_(lead, lines);
  lead.LastUpdatedAt = now; lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  const d = diff_(before, lead);
  audit_(ctx, 'TEST_PROGRESS', lead.LeadID, 'LeadTests', changed.map(l => l.LeadTestID).join(','), d.before, d.after,
    changed.map(l => str_(l.ItemName) + (num_(l.ScansRequired) > 1 ? ' ' + num_(l.ScansDone) + '/' + num_(l.ScansRequired) : '') + (bool_(l.IsDone) ? ' ✓' : '')).join('; '));
  let m5 = null;
  if (scan) { m5 = messageForLead_(ctx, 'M5', lead, lines, scan); autoSendIfApi_(ctx, 'M5', lead, lines, scan); }
  return { leadId: lead.LeadID, status: lead.Status, allDone: allLinesDone_(lines), message: m5 };
}

/* ---------- test edits (re-pricing, audit-logged) ---------- */
const EDITABLE_ST = [ST.GEN, ST.CALLED, ST.NR, ST.BOOKED, ST.LABVISIT, ST.HOME, ST.SAMPLE, ST.FU_AP, ST.FU_WDL];
function canEditTests_(ctx, lead) {
  const s = str_(lead.Status);
  if (ctx.role === ROLE.ADMIN || ctx.role === ROLE.PC) return EDITABLE_ST.indexOf(s) >= 0;
  if (ctx.role === ROLE.CM) return s === ST.GEN;
  return false;
}

function addItem_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(canEditTests_(ctx, lead), 'Tests can\'t be changed at this stage (' + lead.Status + ') by your role.');
  const lines = leadLines_(lead.LeadID);
  const before = pick_(lead, ['ExpectedMRP', 'ExpectedPatientPrice', 'ExpectedMarginRs', 'RevenueState']);
  // Price the addition on the rate card this lead was captured against, not today's —
  // otherwise a v2/v3 activation mid-flight prices one lead off two different cards.
  const rc = rateCardForLead_(lead);
  const built = buildLines_(ctx, lead, [{ code: p.code, tag: p.tag }], rc, { clinicOnly: ctx.role === ROLE.CM, existing: lines });
  if (str_(lead.Status) !== ST.GEN || ctx.role !== ROLE.CM) {
    // Scans/imaging added to a scheduled home collection would break the mode.
    if (str_(lead.Status) === ST.HOME) need_(built.lines.every(l => itemHomeAllowed_(lead.PartnerID, l)), 'This item can\'t be done by home collection. Switch the booking to a Lab visit first.');
  }
  assignLineIds_(built.lines);
  DB.insert(SH.LEADTESTS, built.lines);
  resetGroups_();
  const all = leadLines_(lead.LeadID);
  syncPackageHeaders_(all);
  recomputeTotals_(lead, all);
  if (!(ctx.role === ROLE.CM && str_(lead.Status) === ST.GEN) && [REV.EXPECTED, REV.REPRICED].indexOf(str_(lead.RevenueState)) >= 0) lead.RevenueState = REV.REPRICED;
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  audit_(ctx, 'TEST_ADDED', lead.LeadID, 'LeadTests', built.lines.map(l => l.LeadTestID).join(','), before,
    pick_(lead, ['ExpectedMRP', 'ExpectedPatientPrice', 'ExpectedMarginRs', 'RevenueState']), 'Added ' + built.lines[0].ItemName + ' (' + personLabel_(built.lines[0].PersonTag) + ')');
  return { leadId: lead.LeadID, warnings: built.warnings, patientPrice: lead.ExpectedPatientPrice };
}

function removeLine_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const isAdmin = ctx.role === ROLE.ADMIN;
  need_(canEditTests_(ctx, lead) || (isAdmin && str_(lead.Status) === ST.SAMPLE), 'Tests can\'t be changed at this stage by your role.');
  const lines = leadLines_(lead.LeadID);
  const l = lines.find(x => str_(x.LeadTestID) === str_(p.leadTestId) && bool_(x.Active));
  need_(l, 'Test line not found.');
  need_(!bool_(l.IsDone) || isAdmin, 'A completed test can\'t be removed.');
  const type = str_(l.ItemType);
  if (type === 'PackageComponent') need_(isAdmin, 'Remove the whole package, or ask the Admin to drop a single component.');
  if (!isAdmin || str_(lead.Status) !== ST.GEN) need_(str_(p.note).length >= 3 || ctx.role === ROLE.CM, 'Add a note explaining why the test is removed.');
  const toDeactivate = [l];
  if (type === 'Package') { const pre = str_(l.ItemCode) + ':'; lines.forEach(x => { if (bool_(x.Active) && str_(x.ItemCode).indexOf(pre) === 0) toDeactivate.push(x); }); }
  const remainingPriced = lines.filter(x => bool_(x.Active) && toDeactivate.indexOf(x) < 0 && str_(x.ItemType) !== 'PackageComponent');
  need_(remainingPriced.length > 0, 'This is the last test on the lead — cancel the lead instead.');
  toDeactivate.forEach(x => { x.Active = false; });
  const hdr = syncPackageHeaders_(lines);
  DB.updateMany(SH.LEADTESTS, uniq_(toDeactivate.concat(hdr)));
  const before = pick_(lead, ['ExpectedMRP', 'ExpectedPatientPrice', 'ExpectedMarginRs', 'RevenueState']);
  recomputeTotals_(lead, lines);
  if (!(ctx.role === ROLE.CM && str_(lead.Status) === ST.GEN) && [REV.EXPECTED, REV.REPRICED].indexOf(str_(lead.RevenueState)) >= 0) lead.RevenueState = REV.REPRICED;
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  audit_(ctx, type === 'PackageComponent' ? 'TEST_DROPPED' : 'TEST_REMOVED', lead.LeadID, 'LeadTests', toDeactivate.map(x => x.LeadTestID).join(','),
    before, pick_(lead, ['ExpectedMRP', 'ExpectedPatientPrice', 'ExpectedMarginRs', 'RevenueState']), 'Removed ' + l.ItemName + (p.note ? ' · ' + p.note : ''));
  return { leadId: lead.LeadID, allDone: allLinesDone_(lines), patientPrice: lead.ExpectedPatientPrice };
}

/** Admin-only override of a frozen line price with a mandatory note (BRD §6.3). */
function overrideLine_(ctx, p) {
  const lead = mustLead_(p.leadId);
  const lines = leadLines_(lead.LeadID);
  const l = lines.find(x => str_(x.LeadTestID) === str_(p.leadTestId) && bool_(x.Active));
  need_(l && str_(l.ItemType) !== 'PackageComponent', 'Select a priced test line.');
  need_(str_(p.note).length >= 5, 'A note explaining the override is mandatory.');
  const mrp = Number(p.mrp), price = Number(p.price), margin = Number(p.margin);
  need_(mrp > 0 && price > 0 && price <= mrp, 'Patient price must be > 0 and ≤ MRP.');
  need_(margin > 0 && margin < price, 'Gynoveda margin must be > 0 and less than the patient price.');
  const before = pick_(l, ['FrozenMRP', 'FrozenPatientPrice', 'FrozenMarginRs', 'PartnerShareRs']);
  l.FrozenMRP = round2_(mrp); l.FrozenPatientPrice = round2_(price); l.FrozenMarginRs = round2_(margin); l.PartnerShareRs = round2_(price - margin);
  DB.update(SH.LEADTESTS, l);
  recomputeTotals_(lead, lines);
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  audit_(ctx, 'LINE_PRICE_OVERRIDE', lead.LeadID, 'LeadTests', l.LeadTestID, before,
    pick_(l, ['FrozenMRP', 'FrozenPatientPrice', 'FrozenMarginRs', 'PartnerShareRs']), p.note);
  return { leadId: lead.LeadID };
}

/* ---------- reschedule (M6) ---------- */
function reschedule_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(roleCodeAllows_('P', ctx.role), 'Only the Partner Coordinator or Admin can reschedule.');
  need_(SCHEDULED_ST.indexOf(str_(lead.Status)) >= 0, 'Only scheduled appointments can be rescheduled.');
  const lines = leadLines_(lead.LeadID);
  const before = clone_(lead);
  const s = validateSchedule_(lead, lines, {
    labId: p.labId || lead.AssignedLabID, apptDate: p.apptDate, apptSlot: p.apptSlot,
    collectionAddress: p.collectionAddress || lead.CollectionAddress
  }, lead.Status);
  Object.keys(s).forEach(k => { lead[k] = s[k]; });
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  const d = diff_(before, lead);
  audit_(ctx, 'RESCHEDULED', lead.LeadID, 'Lead', lead.LeadID, d.before, d.after, str_(p.note));
  const msg = messageForLead_(ctx, 'M6', lead, lines);
  autoSendIfApi_(ctx, 'M6', lead, lines);
  return { leadId: lead.LeadID, message: msg };
}

/* ---------- payment entry after a Lab User marked Test done ---------- */
function recordPayment_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(ctx.role === ROLE.PC || ctx.role === ROLE.ADMIN, 'Only the Partner Coordinator or Admin records patient payment.');
  need_([ST.DONE, ST.REPORT, ST.DISPUTED].indexOf(str_(lead.Status)) >= 0, 'Payment is recorded at Test done.');
  const pay = validatePayment_(lead, p, true);
  const before = pick_(lead, ['PaymentAmount', 'PaymentMode', 'PaymentDate', 'PaymentRef']);
  Object.keys(pay).forEach(k => { lead[k] = pay[k]; });
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  audit_(ctx, 'PAYMENT_RECORDED', lead.LeadID, 'Lead', lead.LeadID, before, pay, '');
  return { leadId: lead.LeadID };
}

/* ---------- edit lead fields ---------- */
const CM_EDITABLE = ['PatientName', 'Age', 'Phone', 'Pincode', 'SpouseName', 'SpouseAge', 'ReferringDoctor', 'Urgency', 'PreferredMode', 'NotesForLab'];
const ADMIN_EDITABLE = CM_EDITABLE.concat(['CollectionAddress', 'ApptSlot']);
function editLead_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const isAdmin = ctx.role === ROLE.ADMIN;
  need_(isAdmin || (ctx.role === ROLE.CM && str_(lead.Status) === ST.GEN), 'Clinic Managers can edit a lead only while it is "Lead generated".');
  if (isAdmin) need_(str_(p.note).length >= 3, 'Admin edits need an audit note.');
  const allowed = isAdmin ? ADMIN_EDITABLE : CM_EDITABLE;
  const f = p.fields || {};
  const before = clone_(lead);
  Object.keys(f).forEach(k => {
    need_(allowed.indexOf(k) >= 0, 'Field ' + k + ' can\'t be edited here.');
    let v = f[k];
    if (k === 'Phone') { v = cleanPhone_(v); need_(RE_PHONE.test(v), 'Invalid mobile number.'); }
    if (k === 'Pincode') need_(RE_PIN.test(str_(v)), 'Invalid pincode.');
    if (k === 'Age') { v = Number(v); need_(Number.isInteger(v) && v >= 18 && v <= 65, 'Age must be 18–65.'); }
    if (k === 'SpouseAge' && str_(lead.BookingType) === 'Couple') { v = Number(v); need_(Number.isInteger(v) && v >= cfgNum_('SPOUSE_AGE_MIN') && v <= cfgNum_('SPOUSE_AGE_MAX'), 'Invalid spouse age.'); }
    if (k === 'Urgency') need_(['Normal', 'Urgent'].indexOf(v) >= 0, 'Invalid urgency.');
    if (k === 'PreferredMode') need_(['', 'Lab visit', 'Home collection'].indexOf(v) >= 0, 'Invalid preferred mode.');
    if (k === 'PatientName' || k === 'SpouseName') { v = str_(v); need_(v.length >= 2 && v.length <= 80, 'Name must be 2–80 characters.'); }
    lead[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  });
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  const d = diff_(before, lead);
  audit_(ctx, 'LEAD_EDITED', lead.LeadID, 'Lead', lead.LeadID, d.before, d.after, str_(p.note));
  return { leadId: lead.LeadID };
}

/* ---------- Admin re-route (BRD §4.4) ---------- */
function reroute_(ctx, p) {
  const lead = mustLead_(p.leadId);
  need_([ST.GEN, ST.CALLED, ST.NR, ST.BOOKED, ST.FU_AP, ST.FU_WDL].indexOf(str_(lead.Status)) >= 0,
    'Re-route is possible before scheduling (current status: ' + lead.Status + '). Cancel the schedule first.');
  need_(str_(p.note).length >= 3, 'A re-route note is mandatory.');
  const newClinic = str_(p.clinicId) || str_(lead.ClinicID);
  const newPartner = str_(p.partnerId) || str_(lead.PartnerID);
  const c = clinic_(newClinic); need_(c, 'Clinic not found.');
  const pt = partner_(newPartner); need_(pt && str_(pt.State) === 'Active', 'Target partner must be Active.');
  need_(activeLabsForClinic_(newPartner, newClinic).length, partnerName_(newPartner) + ' has no Active lab serving ' + c.Name + '.');
  const lines = leadLines_(lead.LeadID);
  const before = clone_(lead);
  const changedLines = [];
  if (newPartner !== str_(lead.PartnerID)) {
    const rc = activeRateCard_(newPartner);
    const missing = [];
    lines.filter(l => bool_(l.Active) && str_(l.ItemType) !== 'PackageComponent').forEach(l => {
      const r = rc[str_(l.ItemCode)];
      if (!r) { missing.push(str_(l.ItemName)); return; }
      const m = itemMeta_(r);
      l.FrozenMRP = m.mrp; l.FrozenPatientPrice = m.price; l.FrozenMarginRs = m.margin; l.PartnerShareRs = round2_(m.price - m.margin);
      changedLines.push(l);
    });
    need_(!missing.length, partnerName_(newPartner) + '\'s active rate card doesn\'t include: ' + missing.join(', '));
    DB.updateMany(SH.LEADTESTS, changedLines);
    recomputeTotals_(lead, lines);
    lead.AssignedLabID = ''; lead.ApptDate = ''; lead.ApptSlot = ''; lead.BookingMode = '';
  }
  lead.ClinicID = newClinic; lead.PartnerID = newPartner;
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  const d = diff_(before, lead);
  audit_(ctx, 'LEAD_REROUTED', lead.LeadID, 'Lead', lead.LeadID, d.before, d.after, p.note);
  return { leadId: lead.LeadID };
}

/* ---------- opt-out, notes, dispute flags ---------- */
function setOptOut_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(ctx.role !== ROLE.LAB, 'Not permitted.');
  const before = { OptOut: bool_(lead.OptOut) };
  lead.OptOut = !!p.optOut;
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  audit_(ctx, 'OPT_OUT_SET', lead.LeadID, 'Lead', lead.LeadID, before, { OptOut: lead.OptOut }, str_(p.note));
  return { leadId: lead.LeadID, optOut: lead.OptOut };
}

function addNote_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const note = str_(p.note);
  need_(note.length >= 2, 'Write a note.');
  audit_(ctx, 'NOTE', lead.LeadID, 'Lead', lead.LeadID, null, null, note.slice(0, 1000));
  lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
  DB.update(SH.LEADS, lead);
  return { leadId: lead.LeadID };
}

function flagDispute_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(ctx.role === ROLE.CM || ctx.role === ROLE.PC, 'Admin sets disputes directly from the lead.');
  need_([ST.DONE, ST.REPORT].indexOf(str_(lead.Status)) >= 0, 'Disputes can be flagged on Test done / report-generated leads.');
  const note = str_(p.note);
  need_(note.length >= 5, 'Describe the discrepancy.');
  audit_(ctx, 'DISPUTE_FLAGGED', lead.LeadID, 'Lead', lead.LeadID, null, null, note.slice(0, 1000));
  const admins = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.ADMIN).map(u => u.Email);
  sendMail_(admins.concat([cfgStr_('ADMIN_OWNER_EMAIL')]), '[DCP] Dispute flagged on ' + lead.LeadID,
    '<p>' + escHtml_(ctx.name) + ' (' + escHtml_(ctx.role) + ') flagged a discrepancy on lead <b>' + escHtml_(lead.LeadID) + '</b> (' +
    escHtml_(clinicName_(lead.ClinicID)) + ').</p><p>' + escHtml_(note) + '</p><p>Review it in the Admin → Disputes queue.</p>');
  return { leadId: lead.LeadID };
}

/* ---------- detail ---------- */
function leadDetail_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const lines = leadLines_(lead.LeadID);
  const now = new Date();
  const act = lines.filter(l => bool_(l.Active));
  const out = {
    lead: sanitizeLead_(ctx, lead),
    clinic: pick_(clinic_(lead.ClinicID) || {}, ['ClinicID', 'Name', 'City', 'ClinicPhone', 'Address']),
    partner: { id: str_(lead.PartnerID), name: partnerName_(lead.PartnerID), callingNumber: str_((partner_(lead.PartnerID) || {}).CallingNumber) },
    lab: lead.AssignedLabID ? pick_(lab_(lead.AssignedLabID) || {}, ['LabID', 'LabName', 'Address', 'Pincode', 'LabPhone', 'MapsLink']) : null,
    lines: lines.map(l => {
      const o = sanitizeLine_(ctx, l);
      o.isHeader = isPkgHeader_(l, act);
      o.testCode = lineTestCode_(l);
      return o;
    }),
    reports: leadReports_(lead.LeadID).map(r => pick_(r, ['ReportID', 'PersonTag', 'FileName', 'FileSizeMB', 'UploadedBy', 'UploadedAt', 'Active', 'ReplacedBy', 'Notes'])),
    missingReports: missingReportPersons_(lead),
    sla: slaInfo_(lead, lines, now),
    transitions: availableTransitions_(ctx, lead, lines),
    canEditTests: canEditTests_(ctx, lead),
    canEditLead: ctx.role === ROLE.ADMIN || (ctx.role === ROLE.CM && str_(lead.Status) === ST.GEN),
    canProgress: roleCodeAllows_('L', ctx.role) && [ST.LABVISIT, ST.HOME, ST.SAMPLE].indexOf(str_(lead.Status)) >= 0,
    canReschedule: roleCodeAllows_('P', ctx.role) && SCHEDULED_ST.indexOf(str_(lead.Status)) >= 0,
    canUploadReport: [ROLE.ADMIN, ROLE.PC, ROLE.LAB].indexOf(ctx.role) >= 0 && [ST.SAMPLE, ST.DONE, ST.REPORT, ST.DISPUTED].indexOf(str_(lead.Status)) >= 0,
    canRecordPayment: (ctx.role === ROLE.PC || ctx.role === ROLE.ADMIN) && [ST.DONE, ST.REPORT, ST.DISPUTED].indexOf(str_(lead.Status)) >= 0,
    canFlagDispute: (ctx.role === ROLE.CM || ctx.role === ROLE.PC) && [ST.DONE, ST.REPORT].indexOf(str_(lead.Status)) >= 0,
    messages: messageOptions_(ctx, lead, lines),
    messageLog: leadMessages_(lead.LeadID).map(m => pick_(m, ['MsgID', 'TemplateCode', 'Channel', 'Mode', 'Status', 'SentByUserID', 'SentAt'])),
    activity: leadActivity_(ctx, lead.LeadID),
    pending: pendingLines_(lines).map(l => str_(l.ItemName))
  };
  if (out.canEditTests) out.catalogue = catalogue_(lead.PartnerID, ctx.role === ROLE.CM, ctx);
  const s = str_(lead.Status);
  if (roleCodeAllows_('P', ctx.role) && [ST.BOOKED, ST.LABVISIT, ST.HOME].indexOf(s) >= 0) {
    out.labs = { visit: labOptions_(lead, lines, 'visit'), home: labOptions_(lead, lines, 'home') };
  }
  if (ctx.role === ROLE.ADMIN) {
    out.duplicates = DB.where(SH.DUPES, d => str_(d.PrimaryLeadID) === lead.LeadID || str_(d.DuplicateLeadID) === lead.LeadID).map(clone_);
    out.statementLines = DB.where(SH.STLINES, x => str_(x.LeadID) === lead.LeadID).map(clone_);
    out.partners = DB.where(SH.PARTNERS, x => str_(x.State) === 'Active').map(x => ({ id: str_(x.PartnerID), name: str_(x.DisplayName) }));
  }
  return out;
}

/** Lead timeline. Admin sees full audit JSON; others see actions and notes only. */
function leadActivity_(ctx, leadId) {
  const sh = DB.sheet(SH.AUDIT);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const h = vals[0].map(str_);
  const iL = h.indexOf('LeadID');
  const out = [];
  for (let i = vals.length - 1; i >= 1 && out.length < 200; i--) {
    if (str_(vals[i][iL]) !== str_(leadId)) continue;
    const o = {}; h.forEach((k, j) => { o[k] = normCell_(k, vals[i][j]); });
    if (ctx.role !== ROLE.ADMIN && ['REPORT_VIEWED', 'LINE_PRICE_OVERRIDE'].indexOf(o.Action) >= 0) continue;
    const u = user_(o.UserID);
    const row = { at: str_(o.Timestamp), by: u ? str_(u.Name) : str_(o.UserEmail), role: str_(o.Role), action: str_(o.Action), ref: str_(o.EntityRef), note: str_(o.Note) };
    if (ctx.role === ROLE.ADMIN) { row.before = str_(o.BeforeJSON); row.after = str_(o.AfterJSON); }
    out.push(row);
  }
  return out;
}

function notifyClinicReportReady_(lead, lines) {
  const c = clinic_(lead.ClinicID);
  const cms = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.CM)
    .filter(u => inClinicScope_(buildCtx_(u), lead.ClinicID)).map(u => u.Email);
  if (c && str_(c.ClinicManagerEmail)) cms.push(c.ClinicManagerEmail);
  const url = appUrl_();
  sendMail_(cms, '[DCP] Report ready · ' + lead.LeadID + ' · ' + clinicName_(lead.ClinicID),
    '<p>The diagnostic report for lead <b>' + escHtml_(lead.LeadID) + '</b> (' + escHtml_(testList_(lines)) + ') has been uploaded.</p>' +
    '<p>Open it in the DCP app' + (url ? ' (<a href="' + escHtml_(url) + '">link</a>)' : '') + ' so the doctor can review it at the follow-up consultation.</p>');
}
/* ============================================================================
 *  REPORTS (BRD §7) and PATIENT MESSAGES (BRD §8)
 * ==========================================================================*/

/* ---------- Drive folders ---------- */
function rootFolder_(propKey, name) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(propKey);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  const it = DriveApp.getRootFolder().getFoldersByName(name);
  const f = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(name);
  props.setProperty(propKey, f.getId());
  return f;
}
function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------- upload / replace ---------- */
/**
 * True if the file ends with a %%EOF marker. A well-formed PDF always carries one;
 * its absence means the export or the upload was cut short, which the %PDF header
 * check alone cannot detect. Scans the tail only — the marker is always near the end.
 */
function pdfHasEof_(bytes) {
  const n = bytes.length, from = Math.max(0, n - 2048);
  for (let i = n - 5; i >= from; i--) {
    if (bytes[i] === 37 && bytes[i + 1] === 37 && bytes[i + 2] === 69 && bytes[i + 3] === 79 && bytes[i + 4] === 70) return true;
  }
  return false;
}

function uploadReport_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_([ROLE.ADMIN, ROLE.PC, ROLE.LAB].indexOf(ctx.role) >= 0, 'Your role can\'t upload reports.');
  need_([ST.SAMPLE, ST.DONE, ST.REPORT, ST.DISPUTED].indexOf(str_(lead.Status)) >= 0, 'Reports can be uploaded once samples are collected.');
  const tag = str_(p.personTag) || 'P';
  const persons = personsOf_(lead);
  need_(persons.indexOf(tag) >= 0 || (tag === 'B' && persons.length === 2), 'Select whose report this is.');
  need_(str_(p.b64).length > 0, 'Choose a PDF file.');
  const bytes = Utilities.base64Decode(str_(p.b64));
  need_(bytes.length >= 64, 'The PDF looks empty or damaged — export it again and retry.');
  const sizeMB = bytes.length / 1048576;
  const max = cfgNum_('MAX_REPORT_PDF_MB');
  need_(sizeMB <= max, 'The PDF is ' + sizeMB.toFixed(1) + ' MB — the limit is ' + max + ' MB.');
  need_(bytes.length > 4 && bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70, 'Only PDF files can be uploaded.');
  need_(pdfHasEof_(bytes), 'The PDF looks incomplete — it has no end-of-file marker, so the upload or the export was cut short. Open the file to check it, then upload it again.');

  let old = null;
  if (p.replaceReportId) {
    old = leadReports_(lead.LeadID).find(r => str_(r.ReportID) === str_(p.replaceReportId) && bool_(r.Active));
    need_(old, 'The report being replaced was not found.');
  }
  const n = leadReports_(lead.LeadID).length + 1;
  const fileName = lead.LeadID + '-' + n + '.pdf'; // patient names never appear in file names (BRD §7.3)
  const ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const folder = subFolder_(subFolder_(rootFolder_('REPORTS_FOLDER_ID', 'DCP Reports'), str_(lead.ClinicID)), ym);
  const file = folder.createFile(Utilities.newBlob(bytes, 'application/pdf', fileName));
  const now = nowIST_();
  const rep = {
    ReportID: nextId_(SH.REPORTS, 'ReportID', 'REP-', 4), LeadID: lead.LeadID, PersonTag: tag, FileID: file.getId(),
    FileName: fileName, DrivePath: '/DCP Reports/' + lead.ClinicID + '/' + ym + '/' + fileName,
    FileSizeMB: round2_(sizeMB), UploadedBy: ctx.userId, UploadedAt: now, Active: true, ReplacedBy: '',
    Notes: str_(p.note).slice(0, 300)
  };
  DB.insert(SH.REPORTS, rep);
  if (old) { old.Active = false; old.ReplacedBy = rep.ReportID; DB.update(SH.REPORTS, old); }
  resetGroups_();
  audit_(ctx, old ? 'REPORT_REPLACED' : 'REPORT_UPLOADED', lead.LeadID, 'Report', rep.ReportID,
    old ? { ReportID: old.ReportID } : null, { ReportID: rep.ReportID, PersonTag: tag, FileSizeMB: rep.FileSizeMB }, rep.Notes);

  let transitioned = null;
  if (p.markGenerated && str_(lead.Status) === ST.DONE && !missingReportPersons_(lead).length) {
    transitioned = transition_(ctx, { leadId: lead.LeadID, to: ST.REPORT });
  }
  return { reportId: rep.ReportID, missing: missingReportPersons_(lead), transitioned: transitioned };
}

/** Streams a PDF after a role + scope check; every view is audited (BRD §7.2). */
function getReport_(ctx, p) {
  const rep = DB.get(SH.REPORTS, 'ReportID', p.reportId);
  need_(rep, 'Report not found.');
  const lead = mustLead_(rep.LeadID);
  assertSee_(ctx, lead);
  need_(bool_(rep.Active) || ctx.role === ROLE.ADMIN, 'This report was replaced by a newer version.');
  let blob;
  try { blob = DriveApp.getFileById(str_(rep.FileID)).getBlob(); }
  catch (e) { fail_('The PDF file could not be opened from Drive (it may have been moved or deleted).'); }
  audit_(ctx, 'REPORT_VIEWED', lead.LeadID, 'Report', rep.ReportID, null, null, p.download ? 'download' : 'view');
  return { fileName: str_(rep.FileName), mime: 'application/pdf', b64: Utilities.base64Encode(blob.getBytes()) };
}

/* ---------- templates & merge ---------- */
const NON_ESSENTIAL_MSGS = ['M7', 'M9', 'M-REM'];
function templates_() {
  const m = {};
  DB.rows(SH.TEMPLATES).forEach(t => { m[str_(t.TemplateCode)] = t; });
  return m;
}
function fmtDisplayDate_(s) { const d = parseDT_(str_(s).slice(0, 10)); return d ? Utilities.formatDate(d, TZ, 'dd MMM yyyy') : str_(s); }
function prepNotes_(lines) {
  const notes = uniq_(leadTestCodes_(lines).map(c => { const t = test_(c); return t ? str_(t.PreparationNotes) : ''; }).filter(Boolean));
  const s = notes.join(' | ');
  return s.length > 600 ? s.slice(0, 597) + '…' : (s || 'No special preparation.');
}
function mergeVars_(lead, lines, extra) {
  const c = clinic_(lead.ClinicID) || {}, pt = partner_(lead.PartnerID) || {}, lb = lead.AssignedLabID ? (lab_(lead.AssignedLabID) || {}) : {};
  const pend = pendingLines_(lines).map(l => str_(l.ItemName));
  const v = {
    PatientName: str_(lead.PatientName), DoctorName: str_(lead.ReferringDoctor).replace(/^Dr\.?\s*/i, ''),
    ClinicName: str_(c.Name), ClinicPhone: str_(c.ClinicPhone), TestList: testList_(lines), LeadID: str_(lead.LeadID),
    PartnerName: str_(pt.DisplayName || pt.LegalName), PartnerCallingNumber: str_(pt.CallingNumber),
    PatientPrice: inr_(lead.ExpectedPatientPrice),
    ApptDate: fmtDisplayDate_(lead.ApptDate), ApptTime: str_(lead.ApptSlot), ApptSlot: str_(lead.ApptSlot),
    LabName: str_(lb.LabName), LabAddress: str_(lb.Address), MapsLink: str_(lb.MapsLink), LabPhone: str_(lb.LabPhone),
    PrepNotes: prepNotes_(lines), CollectionAddress: str_(lead.CollectionAddress), Pincode: str_(lead.Pincode),
    BookingMode: str_(lead.BookingMode), ScanNum: '', NextScanDate: fmtDisplayDate_(lead.NextScanDate),
    PendingTestList: pend.join(', ')
  };
  if (extra) {
    if (extra.ScanNum) v.ScanNum = extra.ScanNum;
    if (extra.NextScanDate) v.NextScanDate = fmtDisplayDate_(extra.NextScanDate);
  }
  return v;
}
function mergeTemplate_(body, vars) {
  return String(body).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && str_(vars[k]) !== '' ? String(vars[k]) : '—'));
}
function waLink_(phone, text) { return 'https:\/\/wa.me/91' + str_(phone) + '?text=' + encodeURIComponent(text); }

function messageForLead_(ctx, code, lead, lines, extra) {
  const t = templates_()[code];
  if (!t || !bool_(t.Active)) return null;
  if (bool_(lead.OptOut) && NON_ESSENTIAL_MSGS.indexOf(code) >= 0) return { code: code, name: str_(t.Name), blocked: 'Patient has opted out of non-essential messages.' };
  if (!extra && code === 'M5') {
    const multi = workLines_(lines).find(l => num_(l.ScansRequired) > 1 && !bool_(l.IsDone));
    if (multi) extra = { ScanNum: num_(multi.ScansDone) + 1 };
  }
  const text = mergeTemplate_(str_(t.BodyText), mergeVars_(lead, lines, extra));
  const sent = leadMessages_(lead.LeadID).filter(m => str_(m.TemplateCode) === code);
  return {
    code: code, name: str_(t.Name), text: text, link: waLink_(lead.Phone, text), mode: cfgStr_('MSG_MODE'),
    lastSent: sent.length ? str_(sent[sent.length - 1].SentAt) : '', sentCount: sent.length
  };
}

/** Templates relevant to the lead right now. */
function messageOptions_(ctx, lead, lines) {
  const s = str_(lead.Status), today = todayIST_(), tomorrow = addDaysStr_(today, 1);
  const codes = [];
  if (ctx.role === ROLE.LAB) {
    if (s === ST.SAMPLE && workLines_(lines).some(l => num_(l.ScansRequired) > 1 && !bool_(l.IsDone))) codes.push('M5');
  } else {
    if (TERMINAL_ST.indexOf(s) < 0 && s !== ST.REPORT) codes.push('M1');
    if (s === ST.LABVISIT) codes.push('M2');
    if (s === ST.HOME) codes.push('M3');
    if (SCHEDULED_ST.indexOf(s) >= 0) {
      const ad = str_(lead.ApptDate).slice(0, 10);
      if (ad === tomorrow || ad === today) codes.push('M4');
      codes.push('M6');
    }
    if (s === ST.SAMPLE && workLines_(lines).some(l => num_(l.ScansRequired) > 1 && !bool_(l.IsDone))) codes.push('M5');
    const fu = str_(lead.FollowUpDate).slice(0, 10);
    if ((FOLLOWUP_ST.indexOf(s) >= 0 || s === ST.CALLED) && fu && fu <= today) codes.push('M7');
    if (s === ST.REPORT || s === ST.CLOSED) {
      codes.push('M8');
      if (cfgBool_('M9_SURVEY_ENABLED') && addDaysStr_(str_(lead.ReportGeneratedAt).slice(0, 10), cfgNum_('M9_SURVEY_DELAY_DAYS')) <= today) codes.push('M9');
    }
    if (s === ST.SAMPLE && pendingLines_(lines).length) codes.push('M-REM');
  }
  return codes.map(c => messageForLead_(ctx, c, lead, lines)).filter(Boolean);
}

/** MANUAL mode: logged when staff click the click-to-WhatsApp button (BRD §8.1). */
function logMessage_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  const lines = leadLines_(lead.LeadID);
  const msg = messageForLead_(ctx, str_(p.code), lead, lines);
  need_(msg, 'Template ' + p.code + ' is not active.');
  need_(!msg.blocked, msg.blocked || '');
  const row = {
    MsgID: nextId_(SH.MESSAGES, 'MsgID', 'MSG-', 4), LeadID: lead.LeadID, TemplateCode: msg.code, Channel: 'WhatsApp',
    Mode: 'MANUAL', RecipientPhone: lead.Phone, Status: 'opened', SentByUserID: ctx.userId, SentAt: nowIST_(),
    DeliveredAt: '', ReadAt: '', ErrorNote: ''
  };
  DB.insert(SH.MESSAGES, row);
  return { msgId: row.MsgID };
}

/** Records the patient's 1–5 reply to M9 (MANUAL mode). */
function recordRating_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(ctx.role !== ROLE.LAB, 'Not permitted.');
  const r = Number(p.rating);
  need_([1, 2, 3, 4, 5].indexOf(r) >= 0, 'Rating must be 1–5.');
  need_([ST.REPORT, ST.CLOSED].indexOf(str_(lead.Status)) >= 0, 'Ratings are recorded after the report is generated.');
  DB.insert(SH.MESSAGES, {
    MsgID: nextId_(SH.MESSAGES, 'MsgID', 'MSG-', 4), LeadID: lead.LeadID, TemplateCode: 'M9-REPLY', Channel: 'WhatsApp',
    Mode: 'MANUAL', RecipientPhone: lead.Phone, Status: 'rating:' + r, SentByUserID: ctx.userId, SentAt: nowIST_(),
    DeliveredAt: '', ReadAt: '', ErrorNote: ''
  });
  audit_(ctx, 'CSAT_RECORDED', lead.LeadID, 'Message', 'M9', null, { rating: r }, '');
  return { leadId: lead.LeadID, rating: r };
}

/* ---------- API mode (MSG_MODE = API) ----------
 * Provider-neutral JSON POST. Set Script Properties MSG_API_URL and MSG_API_TOKEN.
 * Adapt buildApiPayload_ to your BSP's format (Gupshup / Interakt / AiSensy / Meta Cloud API).
 */
function buildApiPayload_(code, lead, text, tpl, vars) {
  return { to: '91' + str_(lead.Phone), templateCode: code, whatsappTemplateId: str_(tpl.WhatsAppTemplateID),
    smsTemplateId: str_(tpl.SMSTemplateID), text: text, variables: vars, reference: lead.LeadID };
}
function autoSendIfApi_(ctx, code, lead, lines, extra) {
  if (cfgStr_('MSG_MODE') !== 'API') return null;
  if (bool_(lead.OptOut) && NON_ESSENTIAL_MSGS.indexOf(code) >= 0) return null;
  const tpl = templates_()[code];
  if (!tpl || !bool_(tpl.Active)) return null;
  const vars = mergeVars_(lead, lines, extra);
  const text = mergeTemplate_(str_(tpl.BodyText), vars);
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('MSG_API_URL'), token = props.getProperty('MSG_API_TOKEN');
  let status = 'failed', err = '';
  if (!url) err = 'MSG_API_URL not configured';
  else {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        payload: JSON.stringify(buildApiPayload_(code, lead, text, tpl, vars))
      });
      const sc = res.getResponseCode();
      status = sc >= 200 && sc < 300 ? 'sent' : 'failed';
      if (status === 'failed') err = 'HTTP ' + sc + ': ' + res.getContentText().slice(0, 200);
    } catch (e) { err = e.message; }
  }
  DB.insert(SH.MESSAGES, {
    MsgID: nextId_(SH.MESSAGES, 'MsgID', 'MSG-', 4), LeadID: lead.LeadID, TemplateCode: code, Channel: 'WhatsApp',
    Mode: 'API', RecipientPhone: lead.Phone, Status: status, SentByUserID: ctx ? ctx.userId : 'SYSTEM', SentAt: nowIST_(),
    DeliveredAt: '', ReadAt: '', ErrorNote: err
  });
  MSGS_BY_LEAD_ = null;
  // BRD §8.1 Configurable Fallback: if the WABA send failed, dispatch the DLT-registered SMS template instead.
  if (status === 'failed' && cfgBool_('SMS_FALLBACK_ENABLED')) sendSmsFallback_(ctx, code, lead, tpl, vars);
  return status;
}

/** BRD §8.1 SMS fallback — fires only when the WhatsApp (WABA) send above failed. Needs Script Properties
 *  MSG_SMS_API_URL / MSG_SMS_API_TOKEN and a DLT-registered SMSTemplateID on the template row. */
function buildSmsApiPayload_(code, lead, tpl, vars) {
  return { to: '91' + str_(lead.Phone), templateCode: code, smsTemplateId: str_(tpl.SMSTemplateID), variables: vars, reference: lead.LeadID };
}
function sendSmsFallback_(ctx, code, lead, tpl, vars) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('MSG_SMS_API_URL'), token = props.getProperty('MSG_SMS_API_TOKEN');
  let status = 'failed', err = '';
  if (!str_(tpl.SMSTemplateID)) err = 'No SMSTemplateID on template ' + code + ' — SMS fallback skipped';
  else if (!url) err = 'MSG_SMS_API_URL not configured — SMS fallback skipped';
  else {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        payload: JSON.stringify(buildSmsApiPayload_(code, lead, tpl, vars))
      });
      const sc = res.getResponseCode();
      status = sc >= 200 && sc < 300 ? 'sent' : 'failed';
      if (status === 'failed') err = 'HTTP ' + sc + ': ' + res.getContentText().slice(0, 200);
    } catch (e) { err = e.message; }
  }
  DB.insert(SH.MESSAGES, {
    MsgID: nextId_(SH.MESSAGES, 'MsgID', 'MSG-', 4), LeadID: lead.LeadID, TemplateCode: code, Channel: 'SMS',
    Mode: 'API', RecipientPhone: lead.Phone, Status: status, SentByUserID: ctx ? ctx.userId : 'SYSTEM', SentAt: nowIST_(),
    DeliveredAt: '', ReadAt: '', ErrorNote: err
  });
  MSGS_BY_LEAD_ = null;
  return status;
}

/* ---------- reminders due (M4 / M7 / M9 / M-REM) for MANUAL mode queues ---------- */
function remindersDue_(ctx, leads, now) {
  now = now || new Date();
  const today = fmtD_(now), tomorrow = addDaysStr_(today, 1);
  const remDays = cfgList_('PENDING_TEST_REMINDER_DAYS');
  const out = [];
  leads.forEach(l => {
    const s = str_(l.Status);
    const sent = code => leadMessages_(l.LeadID).filter(m => str_(m.TemplateCode) === code);
    const push = (code, label) => out.push({ leadId: l.LeadID, code: code, label: label, name: str_(l.PatientName), clinic: clinicName_(l.ClinicID), phone: str_(l.Phone) });
    if (ctx.role === ROLE.LAB) return;
    if (SCHEDULED_ST.indexOf(s) >= 0 && str_(l.ApptDate).slice(0, 10) === tomorrow) {
      if (!sent('M4').some(m => str_(m.SentAt).slice(0, 10) >= today)) push('M4', 'Appointment tomorrow');
    }
    const fu = str_(l.FollowUpDate).slice(0, 10);
    if ((FOLLOWUP_ST.indexOf(s) >= 0 || s === ST.CALLED) && fu && fu <= today && !bool_(l.OptOut)) {
      if (!sent('M7').some(m => str_(m.SentAt).slice(0, 10) >= fu)) push('M7', 'Follow-up date ' + fu);
    }
    if ((s === ST.REPORT || s === ST.CLOSED) && cfgBool_('M9_SURVEY_ENABLED') && !bool_(l.OptOut)) {
      const due = addDaysStr_(str_(l.ReportGeneratedAt).slice(0, 10), cfgNum_('M9_SURVEY_DELAY_DAYS'));
      const m9Sent = sent('M9');
      if (due && due <= today && !m9Sent.length) push('M9', 'Satisfaction survey');
      // BRD §16 item 3: care-team call fallback if the M9 survey goes unanswered 48h after it was sent.
      else if (m9Sent.length && !sent('M9-REPLY').length && hoursSince_(m9Sent[m9Sent.length - 1].SentAt, now) >= 48) {
        push('M9-CALL', 'No survey reply after 48h — call the patient');
      }
    }
    if (s === ST.SAMPLE && !bool_(l.OptOut) && pendingLines_(leadLines_(l.LeadID)).length) {
      const age = daysBetweenDates_(str_(l.SampleCollectedAt).slice(0, 10), today);
      const bucket = remDays.filter(d => age !== null && age >= d).length;
      if (bucket > sent('M-REM').length) push('M-REM', 'Pending test reminder · day ' + remDays[bucket - 1]);
    }
  });
  return out;
}

function reminders_(ctx) {
  const now = new Date();
  const leads = leadsInScope_(ctx, {});
  const list = remindersDue_(ctx, leads, now);
  return {
    items: list.map(r => {
      const l = lead_(r.leadId);
      const m = messageForLead_(ctx, r.code, l, leadLines_(l.LeadID));
      return Object.assign(r, { link: m && !m.blocked ? m.link : '', text: m ? m.text : '' });
    })
  };
}

/* ---------- inbound webhook (API mode): STOP opt-outs, M9 ratings, delivery receipts ---------- */
function handleMsgWebhook_(e) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('MSG_WEBHOOK_KEY');
  if (!key || str_(e.parameter.key) !== key) return { ok: false, error: 'unauthorised' };
  let body = {};
  try { body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}'); } catch (x) { return { ok: false, error: 'bad json' }; }
  return withLock_(function () {
    DB.reset(); resetGroups_();
    const phone = cleanPhone_(body.phone || body.from || '');
    const text = str_(body.text || body.message).toUpperCase();
    const res = { ok: true, actions: [] };
    if (RE_PHONE.test(phone) && (text === 'STOP' || text === 'UNSUBSCRIBE')) {
      DB.where(SH.LEADS, l => str_(l.Phone) === phone && !bool_(l.OptOut)).forEach(l => {
        l.OptOut = true; l.LastUpdatedAt = nowIST_(); l.LastUpdatedBy = 'Webhook';
        DB.update(SH.LEADS, l);
        audit_(null, 'OPT_OUT_STOP', l.LeadID, 'Lead', l.LeadID, { OptOut: false }, { OptOut: true }, 'Inbound STOP');
        res.actions.push('optout:' + l.LeadID);
      });
    } else if (RE_PHONE.test(phone) && /^[1-5]$/.test(text)) {
      const l = DB.where(SH.LEADS, x => str_(x.Phone) === phone && [ST.REPORT, ST.CLOSED].indexOf(str_(x.Status)) >= 0)
        .sort((a, b) => str_(b.ReportGeneratedAt).localeCompare(str_(a.ReportGeneratedAt)))[0];
      if (l) {
        DB.insert(SH.MESSAGES, { MsgID: nextId_(SH.MESSAGES, 'MsgID', 'MSG-', 4), LeadID: l.LeadID, TemplateCode: 'M9-REPLY',
          Channel: 'WhatsApp', Mode: 'API', RecipientPhone: phone, Status: 'rating:' + text, SentByUserID: 'PATIENT',
          SentAt: nowIST_(), DeliveredAt: '', ReadAt: '', ErrorNote: '' });
        res.actions.push('rating:' + l.LeadID);
      }
    }
    if (body.msgId && body.status) {
      const m = DB.get(SH.MESSAGES, 'MsgID', body.msgId);
      if (m) {
        const st = str_(body.status).toLowerCase();
        if (st === 'delivered') m.DeliveredAt = nowIST_();
        if (st === 'read') m.ReadAt = nowIST_();
        m.Status = st;
        DB.update(SH.MESSAGES, m);
        res.actions.push('receipt:' + body.msgId);
      }
    }
    flushAudit_();
    return res;
  });
}
/* ============================================================================
 *  SETTLEMENT (BRD §6.4) — statements, partner review, transfers, FIFO
 *  allocation, Collected / Outstanding, closure
 * ==========================================================================*/

const LINE_EXCLUDED = ['Flagged', 'Disputed', 'Void'];
const TRANSFER_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Other'];

/** Partner payment due date: 7th of month M+1 (BRD §6.4 step 3). */
function settlementDueDate_(month) {
  const m = str_(month).match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  let y = Number(m[1]), mo = Number(m[2]) + 1;
  if (mo > 12) { mo = 1; y += 1; }
  return y + '-' + String(mo).padStart(2, '0') + '-07';
}
function partnerShort_(pid) { return str_(pid).replace(/^PT-/, ''); }
function statementId_(pid, month) { return 'STMT-' + partnerShort_(pid) + '-' + month.replace('-', ''); }
function allocKey_(sid, leadId) { return str_(sid) + '|' + str_(leadId); }
function allocatedByLine_() {
  const m = {};
  DB.rows(SH.ALLOCATIONS).forEach(a => { const k = allocKey_(a.StatementID, a.LeadID); m[k] = round2_((m[k] || 0) + num_(a.AllocatedAmountRs)); });
  return m;
}
function lineDue_(line, alloc) { return round2_(num_(line.ContractualMarginRs) - (alloc[allocKey_(line.StatementID, line.LeadID)] || 0)); }
function lineStatusFromAlloc_(line, alloc, fallback) {
  const paid = alloc[allocKey_(line.StatementID, line.LeadID)] || 0;
  if (paid > 0 && lineDue_(line, alloc) <= 0.01) return 'Collected';
  if (paid > 0) return 'Partially collected';
  return fallback || 'Open';
}

function revenueFromAllocations_(lead) {
  const lines = DB.where(SH.STLINES, x => str_(x.LeadID) === str_(lead.LeadID));
  if (!lines.length) return REV.EARNED;
  const alloc = allocatedByLine_();
  const due = lines.reduce((a, l) => a + Math.max(0, lineDue_(l, alloc)), 0);
  const paid = lines.reduce((a, l) => a + (alloc[allocKey_(l.StatementID, l.LeadID)] || 0), 0);
  if (due <= 0.01 && paid > 0) return REV.COLLECTED;
  return paid > 0 ? REV.OUTSTANDING : REV.EARNED;
}

/** Used when a lead is disputed / resolved: keeps statement lines consistent. */
function setStatementLineStatusForLead_(leadId, status, note) {
  const lines = DB.where(SH.STLINES, x => str_(x.LeadID) === str_(leadId));
  if (!lines.length) return;
  const alloc = allocatedByLine_();
  const sids = {};
  lines.forEach(l => {
    l.LineStatus = status === 'Open' ? lineStatusFromAlloc_(l, alloc, 'Open') : status;
    if (note) l.FlagNote = str_(note).slice(0, 300);
    DB.update(SH.STLINES, l);
    sids[str_(l.StatementID)] = 1;
  });
  Object.keys(sids).forEach(recomputeStatement_);
}

function recomputeStatement_(sid) {
  const st = DB.get(SH.STATEMENTS, 'StatementID', sid);
  if (!st) return null;
  const lines = DB.where(SH.STLINES, x => str_(x.StatementID) === str_(sid));
  const inc = lines.filter(l => LINE_EXCLUDED.indexOf(str_(l.LineStatus)) < 0);
  const alloc = allocatedByLine_();
  st.TotalTestDoneLeads = inc.length;
  st.PatientCollectedTotalRs = round2_(inc.reduce((a, l) => a + num_(l.PatientPriceRs), 0));
  st.MarginEarnedContractualRs = round2_(inc.reduce((a, l) => a + num_(l.ContractualMarginRs), 0));
  const crm = inc.filter(l => str_(l.CRMMarginRs) !== '');
  if (crm.length) {
    st.MarginBookedCRMRs = round2_(crm.reduce((a, l) => a + num_(l.CRMMarginRs), 0));
    st.DiscrepancyGapRs = round2_(st.MarginEarnedContractualRs - st.MarginBookedCRMRs);
  }
  const collected = round2_(inc.reduce((a, l) => a + Math.min(num_(l.ContractualMarginRs), alloc[allocKey_(l.StatementID, l.LeadID)] || 0), 0));
  const s = str_(st.Status);
  if (collected > 0 && collected >= st.MarginEarnedContractualRs - 0.01) st.Status = 'Collected';
  else if (collected > 0) st.Status = 'Partially collected';
  else if (s === 'Collected' || s === 'Partially collected') st.Status = str_(st.ConfirmedAt) ? 'Confirmed' : 'Generated';
  DB.update(SH.STATEMENTS, st);
  return { collected: collected, earned: st.MarginEarnedContractualRs };
}

/* ---------- Step 1: generate ---------- */
function generateStatement_(ctx, p) {
  const pid = str_(p.partnerId), month = str_(p.month);
  need_(partner_(pid), 'Select a partner.');
  need_(/^\d{4}-\d{2}$/.test(month), 'Select the month (YYYY-MM).');
  need_(month <= todayIST_().slice(0, 7), 'Statements can\'t be generated for a future month.');
  const onStatement = {};
  DB.rows(SH.STLINES).forEach(l => { onStatement[str_(l.LeadID)] = 1; });
  const eligible = DB.where(SH.LEADS, l => str_(l.PartnerID) === pid && str_(l.TestDoneAt).slice(0, 7) === month &&
    [REV.EARNED, REV.OUTSTANDING].indexOf(str_(l.RevenueState)) >= 0 && !onStatement[str_(l.LeadID)]);
  const sid = statementId_(pid, month);
  let st = DB.get(SH.STATEMENTS, 'StatementID', sid);
  const now = nowIST_();
  if (!st) {
    need_(eligible.length, 'No Test-done leads for ' + partnerName_(pid) + ' in ' + month + ' that aren\'t already on a statement.');
    st = { StatementID: sid, PartnerID: pid, MonthYYYYMM: month, TotalTestDoneLeads: 0, PatientCollectedTotalRs: 0,
      MarginEarnedContractualRs: 0, MarginBookedCRMRs: '', DiscrepancyGapRs: '', Status: 'Generated', GeneratedAt: now,
      ConfirmedAt: '', Notes: 'Generated in DCP app by ' + ctx.name };
    DB.insert(SH.STATEMENTS, st);
  } else {
    need_(eligible.length, 'Statement ' + sid + ' already includes every eligible lead.');
    st.Notes = str_(st.Notes) + ' · Revised ' + now + ' (+' + eligible.length + ' leads)';
    DB.update(SH.STATEMENTS, st);
  }
  const lines = eligible.map(l => ({
    StatementLineID: nextId_(SH.STLINES, 'StatementLineID', 'SL-', 4), StatementID: sid, LeadID: l.LeadID,
    LegacyCRMLeadID: str_(l.LegacyCRMLeadID), ClinicID: l.ClinicID, TestDoneDate: str_(l.TestDoneAt).slice(0, 10),
    TestsSummary: testList_(leadLines_(l.LeadID)).replace(/, /g, ' | '), PatientPriceRs: num_(l.ExpectedPatientPrice),
    ContractualMarginRs: num_(l.ExpectedMarginRs), CRMMarginRs: '', VarianceRs: '', LineStatus: 'Open', FlagNote: ''
  }));
  DB.insert(SH.STLINES, lines);
  recomputeStatement_(sid);
  audit_(ctx, 'STATEMENT_GENERATED', '', 'Statement', sid, null, { lines: lines.length }, month);
  const credit = allocateCredit_(ctx, pid);
  const pcs = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.PC && str_(u.OrgID) === pid).map(u => u.Email);
  sendMail_(pcs, '[DCP] Monthly statement ' + sid + ' ready for review',
    '<p>The ' + escHtml_(month) + ' statement for ' + escHtml_(partnerName_(pid)) + ' is ready in the DCP app (' + lines.length +
    ' new lines). Please confirm it or flag specific lines within ' + cfgNum_('STATEMENT_DISPUTE_WINDOW_DAYS') + ' days.</p>');
  return { statementId: sid, added: lines.length, allocation: credit };
}

/* ---------- Step 2: partner review ---------- */
function canSeeStatement_(ctx, st) { return ctx.role === ROLE.ADMIN || (ctx.role === ROLE.PC && str_(st.PartnerID) === ctx.partnerId); }

function confirmStatement_(ctx, p) {
  const st = DB.get(SH.STATEMENTS, 'StatementID', p.statementId);
  need_(st && canSeeStatement_(ctx, st), 'Statement not found.');
  need_(!str_(st.ConfirmedAt), 'This statement is already confirmed.');
  st.ConfirmedAt = nowIST_();
  if (['Generated', ''].indexOf(str_(st.Status)) >= 0 || /Pending/i.test(str_(st.Status))) st.Status = 'Confirmed';
  DB.update(SH.STATEMENTS, st);
  audit_(ctx, 'STATEMENT_CONFIRMED', '', 'Statement', st.StatementID, null, null, str_(p.note));
  return { statementId: st.StatementID };
}

function flagLine_(ctx, p) {
  const line = DB.get(SH.STLINES, 'StatementLineID', p.statementLineId);
  need_(line, 'Statement line not found.');
  const st = DB.get(SH.STATEMENTS, 'StatementID', line.StatementID);
  need_(st && canSeeStatement_(ctx, st), 'Statement not found.');
  need_(str_(p.note).length >= 5, 'Describe the discrepancy.');
  need_(['Collected', 'Void'].indexOf(str_(line.LineStatus)) < 0, 'This line is already ' + line.LineStatus + '.');
  if (ctx.role === ROLE.PC) {
    const deadline = addDaysStr_(str_(st.GeneratedAt).slice(0, 10), cfgNum_('STATEMENT_DISPUTE_WINDOW_DAYS'));
    need_(todayIST_() <= deadline, 'The review window for this statement closed on ' + deadline + '. Contact the DCP Admin.');
  }
  line.LineStatus = 'Flagged';
  line.FlagNote = str_(p.note).slice(0, 300);
  DB.update(SH.STLINES, line);
  const lead = lead_(line.LeadID);
  if (lead && [ST.DONE, ST.REPORT].indexOf(str_(lead.Status)) >= 0) {
    const before = clone_(lead);
    lead.Status = ST.DISPUTED; lead.RevenueState = REV.FROZEN;
    lead.StatusChangedAt = nowIST_(); lead.LastUpdatedAt = nowIST_(); lead.LastUpdatedBy = ctx.name;
    DB.update(SH.LEADS, lead);
    const d = diff_(before, lead);
    audit_(ctx, 'STATUS_CHANGE', lead.LeadID, 'Lead', before.Status + ' → ' + ST.DISPUTED, d.before, d.after, 'Statement line flagged: ' + line.FlagNote);
  }
  recomputeStatement_(line.StatementID);
  audit_(ctx, 'STATEMENT_LINE_FLAGGED', line.LeadID, 'StatementLine', line.StatementLineID, null, null, line.FlagNote);
  const admins = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.ADMIN).map(u => u.Email);
  sendMail_(admins, '[DCP] Statement line flagged · ' + line.StatementID,
    '<p>' + escHtml_(ctx.name) + ' flagged lead ' + escHtml_(line.LeadID) + ' on ' + escHtml_(line.StatementID) + ':</p><p>' + escHtml_(line.FlagNote) + '</p>');
  return { statementLineId: line.StatementLineID };
}

function resolveLine_(ctx, p) {
  const line = DB.get(SH.STLINES, 'StatementLineID', p.statementLineId);
  need_(line, 'Statement line not found.');
  need_(['valid', 'void'].indexOf(p.resolution) >= 0, 'Choose a resolution.');
  const note = str_(p.note);
  need_(note.length >= 3, 'A resolution note is mandatory.');
  const lead = lead_(line.LeadID);
  if (lead && str_(lead.Status) === ST.DISPUTED) {
    if (p.resolution === 'valid') transition_(ctx, { leadId: lead.LeadID, to: ST.DONE, note: note });
    else transition_(ctx, { leadId: lead.LeadID, to: ST.CANCEL, reason: 'Other (text)', reasonText: 'Statement dispute voided: ' + note, note: note });
  } else {
    const alloc = allocatedByLine_();
    line.LineStatus = p.resolution === 'valid' ? lineStatusFromAlloc_(line, alloc, 'Open') : 'Void';
    line.FlagNote = note.slice(0, 300);
    DB.update(SH.STLINES, line);
    recomputeStatement_(line.StatementID);
  }
  audit_(ctx, 'STATEMENT_LINE_RESOLVED', line.LeadID, 'StatementLine', line.StatementLineID, null, { resolution: p.resolution }, note);
  return { statementLineId: line.StatementLineID };
}

/* ---------- Steps 3–4: transfer + FIFO ---------- */
function recordTransfer_(ctx, p) {
  const pid = str_(p.partnerId);
  need_(partner_(pid), 'Select a partner.');
  need_(isValidDateStr_(p.transferDate) && p.transferDate <= todayIST_(), 'Enter a valid transfer date (not in the future).');
  const amt = Number(p.amountRs), tds = Number(p.tdsDeductedRs || 0);
  need_(isFinite(amt) && amt > 0, 'Transfer amount must be greater than 0.');
  need_(isFinite(tds) && tds >= 0, 'TDS must be 0 or more.');
  need_(TRANSFER_MODES.indexOf(str_(p.paymentMode)) >= 0, 'Select the payment mode.');
  const utr = str_(p.utr).toUpperCase();
  need_(utr.length >= 6, 'Enter the UTR / reference number.');
  need_(!DB.rows(SH.TRANSFERS).some(t => str_(t.PartnerID) === pid && str_(t.UTR).toUpperCase() === utr), 'A transfer with UTR ' + utr + ' is already recorded.');
  const tr = {
    TransferID: nextId_(SH.TRANSFERS, 'TransferID', 'TRF-', 4), PartnerID: pid, TransferDate: p.transferDate,
    AmountRs: round2_(amt), UTR: utr, PaymentMode: p.paymentMode, TDSDeductedRs: round2_(tds), AllocatedAmountRs: 0,
    UnallocatedAmountRs: round2_(amt + tds), RecordedBy: ctx.userId, RecordedAt: nowIST_(), Notes: str_(p.notes).slice(0, 300)
  };
  DB.insert(SH.TRANSFERS, tr);
  audit_(ctx, 'TRANSFER_RECORDED', '', 'Transfer', tr.TransferID, null, pick_(tr, ['PartnerID', 'TransferDate', 'AmountRs', 'TDSDeductedRs', 'UTR']), tr.Notes);
  const res = allocateCredit_(ctx, pid);
  return { transferId: tr.TransferID, allocation: res };
}

/** FIFO: applies every unallocated transfer balance to the oldest open statement lines first (BRD §6.4 step 4). */
function allocateCredit_(ctx, pid) {
  const transfers = DB.where(SH.TRANSFERS, t => str_(t.PartnerID) === pid && num_(t.UnallocatedAmountRs) > 0.005)
    .sort((a, b) => str_(a.TransferDate).localeCompare(str_(b.TransferDate)) || str_(a.TransferID).localeCompare(str_(b.TransferID)));
  const stmts = {};
  DB.where(SH.STATEMENTS, s => str_(s.PartnerID) === pid).forEach(s => { stmts[str_(s.StatementID)] = s; });
  const alloc = allocatedByLine_();
  const lines = DB.where(SH.STLINES, l => stmts[str_(l.StatementID)] && LINE_EXCLUDED.indexOf(str_(l.LineStatus)) < 0)
    .sort((a, b) => str_(a.TestDoneDate).localeCompare(str_(b.TestDoneDate)) || str_(a.StatementID).localeCompare(str_(b.StatementID)) ||
      str_(a.StatementLineID).localeCompare(str_(b.StatementLineID)));
  const newAllocs = [], touchedTransfers = [];
  let total = 0;
  const now = nowIST_();
  transfers.forEach(t => {
    let pool = round2_(num_(t.UnallocatedAmountRs));
    for (let i = 0; i < lines.length && pool > 0.005; i++) {
      const l = lines[i];
      const due = lineDue_(l, alloc);
      if (due <= 0.005) continue;
      const a = round2_(Math.min(pool, due));
      newAllocs.push({ AllocationID: nextId_(SH.ALLOCATIONS, 'AllocationID', 'ALC-', 4), TransferID: t.TransferID,
        StatementID: l.StatementID, LeadID: l.LeadID, AllocatedAmountRs: a, AllocatedAt: now, AllocatedBy: ctx ? ctx.userId : 'SYSTEM' });
      const k = allocKey_(l.StatementID, l.LeadID);
      alloc[k] = round2_((alloc[k] || 0) + a);
      pool = round2_(pool - a);
      total = round2_(total + a);
    }
    if (round2_(num_(t.UnallocatedAmountRs)) !== pool) {
      t.AllocatedAmountRs = round2_(num_(t.AllocatedAmountRs) + num_(t.UnallocatedAmountRs) - pool);
      t.UnallocatedAmountRs = pool;
      touchedTransfers.push(t);
    }
  });
  if (newAllocs.length) DB.insert(SH.ALLOCATIONS, newAllocs);
  if (touchedTransfers.length) DB.updateMany(SH.TRANSFERS, touchedTransfers);

  // Line + lead revenue states
  const hasTransfers = DB.rows(SH.TRANSFERS).some(t => str_(t.PartnerID) === pid && num_(t.AmountRs) > 0);
  const changedLines = [], changedLeads = [];
  let covered = 0, partial = 0, outstanding = 0;
  lines.forEach(l => {
    const ns = lineStatusFromAlloc_(l, alloc, str_(l.LineStatus) === 'Collected' || str_(l.LineStatus) === 'Partially collected' ? 'Open' : str_(l.LineStatus) || 'Open');
    if (ns !== str_(l.LineStatus)) { l.LineStatus = ns; changedLines.push(l); }
    if (ns === 'Collected') covered++; else if (ns === 'Partially collected') partial++; else outstanding++;
    const lead = lead_(l.LeadID);
    if (lead && [REV.EARNED, REV.OUTSTANDING, REV.COLLECTED].indexOf(str_(lead.RevenueState)) >= 0) {
      const rs = ns === 'Collected' ? REV.COLLECTED : (hasTransfers ? REV.OUTSTANDING : REV.EARNED);
      if (rs !== str_(lead.RevenueState)) { lead.RevenueState = rs; lead.LastUpdatedAt = now; changedLeads.push(lead); }
    }
  });
  if (changedLines.length) DB.updateMany(SH.STLINES, changedLines);
  if (changedLeads.length) DB.updateMany(SH.LEADS, changedLeads);
  Object.keys(stmts).forEach(recomputeStatement_);
  if (newAllocs.length) audit_(ctx, 'FIFO_ALLOCATED', '', 'Partner', pid, null, { allocations: newAllocs.length, amount: total }, '');
  const credit = round2_(DB.where(SH.TRANSFERS, t => str_(t.PartnerID) === pid).reduce((a, t) => a + num_(t.UnallocatedAmountRs), 0));
  return { allocated: total, allocations: newAllocs.length, linesCollected: covered, linesPartial: partial, linesOutstanding: outstanding, unallocatedCredit: credit };
}

/* ---------- Step 5: closure ---------- */
function closeEligible_(ctx) {
  const eligible = DB.where(SH.LEADS, l => str_(l.Status) === ST.REPORT && str_(l.RevenueState) === REV.COLLECTED && !missingReportPersons_(l).length);
  eligible.forEach(l => transition_(ctx, { leadId: l.LeadID, to: ST.CLOSED, note: 'Bulk close: report uploaded + commission collected' }));
  return { closed: eligible.length };
}

/* ---------- views ---------- */
function listStatements_(ctx, p) {
  const alloc = allocatedByLine_();
  const pid = ctx.role === ROLE.PC ? ctx.partnerId : str_(p.partnerId);
  const today = todayIST_();
  const rate = cfgNum_('LATE_PAYMENT_INTEREST_MONTHLY_PCT');
  const list = DB.where(SH.STATEMENTS, s => !pid || str_(s.PartnerID) === pid).map(s => {
    const lines = DB.where(SH.STLINES, l => str_(l.StatementID) === str_(s.StatementID));
    const inc = lines.filter(l => LINE_EXCLUDED.indexOf(str_(l.LineStatus)) < 0);
    const collected = round2_(inc.reduce((a, l) => a + Math.min(num_(l.ContractualMarginRs), alloc[allocKey_(l.StatementID, l.LeadID)] || 0), 0));
    const earned = round2_(inc.reduce((a, l) => a + num_(l.ContractualMarginRs), 0));
    const dueBy = settlementDueDate_(str_(s.MonthYYYYMM));
    const overdueDays = dueBy && today > dueBy && earned - collected > 0.01 ? daysBetweenDates_(dueBy, today) : 0;
    const o = clone_(s);
    o.partnerName = partnerName_(s.PartnerID);
    o.lineCount = lines.length;
    o.flagged = lines.filter(l => str_(l.LineStatus) === 'Flagged' || str_(l.LineStatus) === 'Disputed').length;
    o.collectedRs = collected; o.earnedRs = earned; o.outstandingRs = round2_(earned - collected);
    o.dueBy = dueBy; o.overdueDays = overdueDays;
    o.lateInterestRs = overdueDays ? round2_((earned - collected) * rate / 100 * overdueDays / 30) : 0;
    o.reviewDeadline = addDaysStr_(str_(s.GeneratedAt).slice(0, 10), cfgNum_('STATEMENT_DISPUTE_WINDOW_DAYS'));
    return o;
  }).sort((a, b) => str_(b.MonthYYYYMM).localeCompare(str_(a.MonthYYYYMM)));
  const transfers = ctx.role === ROLE.ADMIN ? DB.where(SH.TRANSFERS, t => !pid || str_(t.PartnerID) === pid).map(clone_)
    .sort((a, b) => str_(b.TransferDate).localeCompare(str_(a.TransferDate))) : [];
  return { statements: list, transfers: transfers };
}

function statementLines_(ctx, p) {
  const st = DB.get(SH.STATEMENTS, 'StatementID', p.statementId);
  need_(st && canSeeStatement_(ctx, st), 'Statement not found.');
  const alloc = allocatedByLine_();
  return {
    statement: clone_(st),
    reviewDeadline: addDaysStr_(str_(st.GeneratedAt).slice(0, 10), cfgNum_('STATEMENT_DISPUTE_WINDOW_DAYS')),
    lines: DB.where(SH.STLINES, l => str_(l.StatementID) === str_(st.StatementID)).map(l => {
      const o = clone_(l);
      o.allocatedRs = alloc[allocKey_(l.StatementID, l.LeadID)] || 0;
      o.dueRs = Math.max(0, lineDue_(l, alloc));
      o.clinic = clinicName_(l.ClinicID);
      const lead = lead_(l.LeadID);
      o.leadStatus = lead ? str_(lead.Status) : '(legacy — not in Leads)';
      return o;
    })
  };
}
/* ============================================================================
 *  ADMIN — users & scopes (§2), master data (§11), partner/lab registration &
 *  activation (§12), rate-card versions, duplicates, disputes, audit, config
 * ==========================================================================*/

/* ---------- users ---------- */
const USER_PUBLIC = ['UserID', 'Email', 'Name', 'Mobile', 'Role', 'OrgType', 'OrgID', 'ScopeType', 'ScopeIDs', 'TempPasswordExpiry',
  'FailedAttempts', 'LockedUntil', 'ForcePasswordChange', 'Active', 'CreatedAt', 'Notes'];
const ROLE_CODE = { 'Admin': 'ADM', 'Clinic Manager': 'CM', 'Partner Coordinator': 'PC', 'Lab User': 'LU' };

function listUsers_(ctx) {
  const now = new Date();
  return DB.rows(SH.USERS).map(u => {
    const o = pick_(u, USER_PUBLIC);
    o.Active = bool_(u.Active); o.ForcePasswordChange = bool_(u.ForcePasswordChange);
    const lu = parseDT_(u.LockedUntil);
    o.locked = !!(lu && lu > now);
    o.hasPassword = !!str_(u.PasswordHash);
    o.orgName = str_(u.Role) === ROLE.CM ? clinicName_(u.OrgID) : str_(u.Role) === ROLE.PC ? partnerName_(u.OrgID) : str_(u.Role) === ROLE.LAB ? labName_(u.OrgID) : 'Gynoveda HQ';
    return o;
  });
}

function validateUser_(u, selfId) {
  u.Email = str_(u.Email).toLowerCase();
  need_(RE_EMAIL.test(u.Email), 'Enter a valid email (it is the login ID).');
  need_(!DB.rows(SH.USERS).some(x => str_(x.Email).toLowerCase() === u.Email && str_(x.UserID) !== str_(selfId)),
    'This email already has a login. One email maps to exactly one role (BRD §2.3).');
  u.Name = str_(u.Name); need_(u.Name.length >= 2, 'Enter the user\'s name.');
  u.Mobile = cleanPhone_(u.Mobile); need_(RE_PHONE.test(u.Mobile), 'Enter a valid 10-digit mobile.');
  need_(Object.keys(ROLE_CODE).indexOf(u.Role) >= 0, 'Select a role.');
  const ids = splitList_(u.ScopeIDs);
  if (u.Role === ROLE.ADMIN) { u.OrgType = 'Gynoveda'; u.OrgID = 'HQ'; u.ScopeType = 'ALL'; u.ScopeIDs = 'ALL'; }
  if (u.Role === ROLE.CM) {
    need_(clinic_(u.OrgID), 'Select the clinic.');
    u.OrgType = 'Clinic'; u.ScopeType = 'CLINIC';
    const all = uniq_([str_(u.OrgID)].concat(ids));
    all.forEach(id => need_(clinic_(id), 'Unknown clinic ' + id));
    u.ScopeIDs = all.join(',');
  }
  if (u.Role === ROLE.PC) {
    need_(partner_(u.OrgID), 'Select the partner.');
    u.OrgType = 'Partner';
    u.ScopeType = str_(u.ScopeType).toUpperCase();
    need_(['REGION', 'AREA', 'CLINIC'].indexOf(u.ScopeType) >= 0, 'Partner Coordinator scope must be REGION, AREA or CLINIC.');
    need_(ids.length, 'Select at least one ' + u.ScopeType.toLowerCase() + ' for the scope.');
    const tbl = u.ScopeType === 'REGION' ? [SH.REGIONS, 'RegionID'] : u.ScopeType === 'AREA' ? [SH.AREAS, 'AreaID'] : [SH.CLINICS, 'ClinicID'];
    ids.forEach(id => need_(DB.get(tbl[0], tbl[1], id), 'Unknown ' + u.ScopeType.toLowerCase() + ' ' + id));
    u.ScopeIDs = ids.join(',');
  }
  if (u.Role === ROLE.LAB) {
    const lb = lab_(u.OrgID);
    need_(lb, 'Select the lab.');
    u.OrgType = 'Lab'; u.ScopeType = 'LAB'; u.ScopeIDs = str_(u.OrgID);
  }
  return u;
}

function saveUser_(ctx, p) {
  const input = p.user || {};
  const isNew = !str_(input.UserID);
  let u;
  if (isNew) {
    u = validateUser_(pick_(input, ['Email', 'Name', 'Mobile', 'Role', 'OrgID', 'ScopeType', 'ScopeIDs', 'Notes']), '');
    u.UserID = nextId_(SH.USERS, 'UserID', 'USR-' + ROLE_CODE[u.Role] + '-', 3);
    u.PasswordHash = ''; u.TempPasswordExpiry = ''; u.FailedAttempts = 0; u.LockedUntil = '';
    u.ForcePasswordChange = true; u.Active = true; u.CreatedAt = todayIST_(); u.Notes = str_(input.Notes);
    DB.insert(SH.USERS, u);
    audit_(ctx, 'USER_CREATED', '', 'User', u.UserID, null, pick_(u, ['Email', 'Role', 'OrgID', 'ScopeType', 'ScopeIDs']), str_(input.Notes));
  } else {
    u = user_(input.UserID);
    need_(u, 'User not found.');
    const before = pick_(u, ['Email', 'Name', 'Mobile', 'Role', 'OrgID', 'ScopeType', 'ScopeIDs', 'Notes']);
    if (str_(u.UserID) === ctx.userId) need_(input.Role === ROLE.ADMIN, 'You can\'t change your own role.');
    const merged = validateUser_(Object.assign(pick_(u, ['Email', 'Name', 'Mobile', 'Role', 'OrgID', 'ScopeType', 'ScopeIDs', 'Notes']),
      pick_(input, ['Email', 'Name', 'Mobile', 'Role', 'OrgID', 'ScopeType', 'ScopeIDs', 'Notes'])), u.UserID);
    Object.keys(merged).forEach(k => { u[k] = merged[k]; });
    DB.update(SH.USERS, u);
    const d = diff_(before, u);
    audit_(ctx, d.after.ScopeIDs !== undefined || d.after.Role !== undefined || d.after.OrgID !== undefined ? 'USER_SCOPE_UPDATED' : 'USER_UPDATED',
      '', 'User', u.UserID, d.before, d.after, str_(p.note));
  }
  let temp = null;
  if (p.sendTempPassword) temp = issueTempPassword_(ctx, u, isNew ? 'New user' : 'Admin reset');
  return { userId: u.UserID, temp: temp };
}

function setUserActive_(ctx, p) {
  const u = user_(p.userId); need_(u, 'User not found.');
  need_(str_(u.UserID) !== ctx.userId, 'You can\'t deactivate yourself.');
  const before = { Active: bool_(u.Active) };
  u.Active = !!p.active;
  DB.update(SH.USERS, u);
  audit_(ctx, p.active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', '', 'User', u.UserID, before, { Active: u.Active }, str_(p.note));
  return { userId: u.UserID, active: u.Active };
}
function sendTemp_(ctx, p) {
  const u = user_(p.userId); need_(u, 'User not found.');
  need_(bool_(u.Active), 'Activate the user first.');
  return issueTempPassword_(ctx, u, 'Admin issued');
}
function unlockUser_(ctx, p) {
  const u = user_(p.userId); need_(u, 'User not found.');
  u.FailedAttempts = 0; u.LockedUntil = '';
  DB.update(SH.USERS, u);
  audit_(ctx, 'USER_UNLOCKED', '', 'User', u.UserID, null, null, '');
  return { userId: u.UserID };
}

/* ---------- generic master-data editor ---------- */
const MD_TABLES = {
  Regions: 'RegionID', Areas: 'AreaID', Clinics: 'ClinicID', Partners: 'PartnerID', Labs: 'LabID', Tests: 'TestCode',
  Packages: 'PackageCode', RateCards: 'RateCardID', Templates: 'TemplateCode', ClinicFootfall: 'RecordID', Config: 'Key'
};
const BOOL_COLS = ['Active', 'PilotScope', 'MaleOnly', 'HomeCollectionAllowed', 'VisibleToClinics', 'IncludesScans', 'ActiveInPilot'];

function mdList_(ctx, p) {
  const table = str_(p.table);
  need_(MD_TABLES[table], 'Unknown table.');
  const q = str_(p.q).toLowerCase();
  const headers = DB.headers(table).filter(Boolean);
  let rows = DB.rows(table).map(r => {
    const o = clone_(r);
    BOOL_COLS.forEach(k => { if (o[k] !== undefined) o[k] = bool_(o[k]); });
    return o;
  });
  if (q) rows = rows.filter(r => headers.some(h => str_(r[h]).toLowerCase().indexOf(q) >= 0));
  if (p.state) rows = rows.filter(r => str_(r.State || r.Status) === p.state);
  if (p.partnerId) rows = rows.filter(r => str_(r.PartnerID) === p.partnerId);
  const total = rows.length, size = 100, page = Math.max(0, Number(p.page) || 0);
  return { table: table, key: MD_TABLES[table], headers: headers, rows: rows.slice(page * size, page * size + size), total: total, page: page, pageSize: size };
}

function validateRateLine_(r) {
  const errs = [];
  const mrp = num_(r.MRP), price = num_(r.PatientPrice), margin = num_(r.GynovedaMarginRs);
  const type = str_(r.ItemType);
  if (['SingleTest', 'Package'].indexOf(type) < 0) errs.push('ItemType must be SingleTest or Package');
  if (type === 'SingleTest' && !test_(r.ItemCode)) errs.push('Unknown test code ' + r.ItemCode);
  if (type === 'Package' && !package_(r.ItemCode)) errs.push('Unknown package code ' + r.ItemCode);
  if (!(mrp > 0)) errs.push('MRP must be > 0');
  if (!(price > 0 && price <= mrp)) errs.push('PatientPrice must be > 0 and ≤ MRP');
  if (!(margin > 0 && margin < price)) errs.push('GynovedaMarginRs must be > 0 and < PatientPrice');
  if (!(num_(r.TATHours) > 0)) errs.push('TATHours must be > 0');
  return errs;
}

function mdSave_(ctx, p) {
  const table = str_(p.table), key = MD_TABLES[table];
  need_(key, 'Unknown table.');
  const input = p.row || {};
  const id = str_(input[key]);
  need_(id, key + ' is required.');
  const existing = DB.get(table, key, id);
  if (p.isNew) need_(!existing, key + ' ' + id + ' already exists.');
  else need_(existing, key + ' ' + id + ' not found.');
  const headers = DB.headers(table).filter(Boolean);
  const beforeSnap = existing ? clone_(existing) : {};
  const row = existing ? clone_(existing) : {};
  headers.forEach(h => { if (input[h] !== undefined) row[h] = BOOL_COLS.indexOf(h) >= 0 ? !!input[h] && input[h] !== 'FALSE' : (typeof input[h] === 'string' ? input[h].trim() : input[h]); });
  const prevState = existing ? str_(existing.State || existing.Status) : '';

  if (table === 'Partners' || table === 'Labs') {
    if (str_(row.State) === 'Active' && prevState !== 'Active') fail_('Use "Validate & Activate" to activate — it runs the BRD §12.4 checks.');
    need_(['Draft', 'Active', 'Suspended', 'Rejected', ''].indexOf(str_(row.State)) >= 0, 'State must be Draft, Active or Suspended.');
  }
  if (table === 'Labs') {
    need_(partner_(row.PartnerID), 'Unknown PartnerID.');
    if (str_(row.Pincode)) need_(RE_PIN.test(str_(row.Pincode)), 'Pincode must be 6 digits.');
    need_(['Lab visit', 'Home collection', 'Both', 'Pathology only', ''].indexOf(str_(row.Modes)) >= 0, 'Modes must be Lab visit, Home collection or Both.');
  }
  if (table === 'RateCards') {
    if (str_(row.State) === 'Active' && prevState !== 'Active') fail_('Use "Activate items" or "Activate version" to make rate-card lines Active.');
    if (existing && prevState === 'Active') {
      ['MRP', 'PatientPrice', 'GynovedaMarginRs', 'ItemCode', 'PartnerID'].forEach(k => {
        need_(str_(existing[k]) === str_(row[k]), 'Active rate-card prices are frozen. Create a new version for commercial changes (BRD §6.1).');
      });
    }
    const errs = validateRateLine_(row);
    need_(!errs.length, errs.join('; '));
    row.PartnerB2BShareRs = round2_(num_(row.PatientPrice) - num_(row.GynovedaMarginRs));
    row.MarginPctOfMRP = round2_(num_(row.GynovedaMarginRs) / num_(row.MRP) * 10000) / 10000;
  }
  if (table === 'Clinics') {
    need_(['Active', 'Paused', 'Closed', 'Staged'].indexOf(str_(row.Status)) >= 0, 'Status must be Active, Paused, Closed or Staged.');
    need_(RE_PIN.test(str_(row.Pincode)), 'Pincode must be 6 digits.');
    need_(DB.get(SH.AREAS, 'AreaID', row.AreaID), 'Unknown AreaID.');
    need_(DB.get(SH.REGIONS, 'RegionID', row.RegionID), 'Unknown RegionID.');
    if (str_(row.Status) === 'Active') {
      const pt = partner_(row.DefaultPartnerID);
      need_(pt && str_(pt.State) === 'Active', 'An Active clinic needs an Active DefaultPartnerID.');
    }
    if (!/Other/i.test(str_(row.ReferringDoctors))) row.ReferringDoctors = splitList_(row.ReferringDoctors, '|').concat(['Other — type name']).join('|');
  }
  if (table === 'Tests') {
    need_(['F', 'M', 'F/M'].indexOf(str_(row.GenderApplicability)) >= 0, 'GenderApplicability must be F, M or F/M.');
    need_(Number.isInteger(Number(row.ScansRequired)) && Number(row.ScansRequired) >= 1, 'ScansRequired must be a whole number ≥ 1.');
    need_(num_(row.DefaultTATHours) > 0, 'DefaultTATHours must be > 0.');
  }
  if (table === 'Packages') {
    splitList_(row.FemaleTestCodes).concat(splitList_(row.MaleTestCodes)).forEach(c => need_(test_(c), 'Unknown test code ' + c + ' in package.'));
  }
  if (table === 'Config') {
    if (/_HOURS$|_DAYS$|_MINUTES$|_ATTEMPTS$|_PCT$|_MB$|_SECONDS$|_FEE$|_COUNT$|_LENGTH$|_ITERATIONS$|_MIN$|_MAX$/.test(id) && id !== 'PENDING_TEST_REMINDER_DAYS')
      need_(isFinite(Number(row.Value)) && str_(row.Value) !== '', id + ' must be a number.');
    if (id === 'MSG_MODE') need_(['MANUAL', 'API'].indexOf(str_(row.Value)) >= 0, 'MSG_MODE must be MANUAL or API.');
    if (id === 'PACKAGE_INDIVIDUAL_RULE') need_(['REQUIRE_COUPLE', 'PATIENT_COMPONENTS_ONLY'].indexOf(str_(row.Value)) >= 0, 'Use REQUIRE_COUPLE or PATIENT_COMPONENTS_ONLY.');
    if (id === 'PENDING_TEST_REMINDER_DAYS') need_(/^\d+(,\d+)*$/.test(str_(row.Value)), 'Use comma-separated days, e.g. 3,7,14.');
    if (id === 'PBKDF2_ITERATIONS') need_(Number(row.Value) >= 1000 && Number(row.Value) <= 20000, 'Iterations must be 1000–20000.');
    row.UpdatedAt = nowIST_(); row.UpdatedBy = ctx.email;
  }
  if (table === 'ClinicFootfall') {
    need_(clinic_(row.ClinicID), 'Unknown ClinicID.');
    need_(/^\d{4}-\d{2}$/.test(str_(row.MonthYYYYMM)), 'MonthYYYYMM must look like 2026-10.');
    need_(num_(row.Footfall1Cx) >= 0, 'Footfall1Cx must be 0 or more.');
    row.ClinicName = clinicName_(row.ClinicID);
    if (num_(row.Footfall1Cx) > 0 && str_(row.DCPLeads) !== '') row.AdoptionPct = round2_(num_(row.DCPLeads) / num_(row.Footfall1Cx) * 10000) / 10000;
  }
  if (table === 'Templates') need_(str_(row.BodyText).length >= 10, 'Template body is required.');

  if (existing) {
    Object.keys(row).forEach(k => { existing[k] = row[k]; });
    DB.update(table, existing);
  } else DB.insert(table, row);
  CFG_ = null;
  RC_CACHE_ = {};
  const d = diff_(beforeSnap, row);
  audit_(ctx, existing ? 'MASTER_UPDATED' : 'MASTER_CREATED', '', table, id, existing ? d.before : null, d.after, str_(p.note));
  return { table: table, id: id };
}

/* ---------- partner & lab validation (BRD §12.4) ---------- */
function normAddr_(s) { return str_(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isMobile_(v) { return RE_PHONE.test(cleanPhone_(v)); }

function labValidation_(lab, addrIndex) {
  const errors = [], warnings = [];
  ['LabID', 'LabName', 'Address', 'LabManagerName'].forEach(k => { if (!str_(lab[k])) errors.push(k + ' missing'); });
  if (!RE_PIN.test(str_(lab.Pincode))) errors.push('Pincode invalid');
  if (!/^https?:\/\//.test(str_(lab.MapsLink))) errors.push('Google Maps link missing');
  if (!/^\+?[\d\s-]{10,15}$/.test(str_(lab.LabPhone))) errors.push('Lab phone invalid');
  if (!isMobile_(lab.LabManagerMobile)) errors.push('Lab manager mobile invalid');
  if (str_(lab.LabManagerEmail) && !RE_EMAIL.test(str_(lab.LabManagerEmail))) errors.push('Lab manager email invalid');
  const served = splitList_(lab.ClinicIDServed);
  if (!served.length) errors.push('ClinicIDServed missing');
  served.forEach(c => { if (!clinic_(c)) errors.push('Unknown clinic ' + c); });
  const modes = str_(lab.Modes);
  if (['Lab visit', 'Home collection', 'Both', 'Pathology only'].indexOf(modes) < 0) errors.push('Modes invalid');
  if ((modes === 'Both' || modes === 'Home collection') && !labHomePins_(lab).length) errors.push('Home-collection pincodes missing');
  if (!splitList_(lab.TestsPerformed).length) errors.push('TestsPerformed missing');
  if (!str_(lab.NABLCertNumber)) warnings.push('NABL / ISO certificate number blank');
  if (addrIndex) {
    const others = (addrIndex[normAddr_(lab.Address)] || []).filter(pid => pid !== str_(lab.PartnerID));
    if (others.length) warnings.push('Same address as a lab of ' + uniq_(others).map(partnerName_).join(', '));
  }
  return { labId: str_(lab.LabID), name: str_(lab.LabName), state: str_(lab.State), errors: errors, warnings: warnings };
}

function addrIndex_() {
  const m = {};
  DB.rows(SH.LABS).forEach(l => { const k = normAddr_(l.Address); if (k) (m[k] = m[k] || []).push(str_(l.PartnerID)); });
  return m;
}

function partnerValidation_(ctx, p) {
  const pt = partner_(p.partnerId);
  need_(pt, 'Partner not found.');
  const pid = str_(pt.PartnerID);
  const errors = [], warnings = [];
  ['LegalName', 'DisplayName', 'AgreementRef', 'AgreementDate', 'PrimaryContactName', 'EscalationContactName', 'CallingNumber']
    .forEach(k => { if (!str_(pt[k])) errors.push('Partner: ' + k + ' missing'); });
  if (['Aggregator', 'Own Labs', 'Own labs'].indexOf(str_(pt.Type)) < 0) errors.push('Partner: Type must be Aggregator or Own labs');
  if (!str_(pt.ValidityMonths)) errors.push('Partner: ValidityMonths missing');
  if (!isMobile_(pt.PrimaryContactMobile)) errors.push('Partner: PrimaryContactMobile invalid');
  if (!isMobile_(pt.EscalationContactMobile)) errors.push('Partner: EscalationContactMobile invalid');
  if (!RE_EMAIL.test(str_(pt.PrimaryContactEmail))) errors.push('Partner: PrimaryContactEmail invalid');
  if (!RE_EMAIL.test(str_(pt.EscalationContactEmail))) errors.push('Partner: EscalationContactEmail invalid');
  if (DB.rows(SH.PARTNERS).some(x => str_(x.PartnerID) !== pid && (normAddr_(x.LegalName) === normAddr_(pt.LegalName) || normAddr_(x.DisplayName) === normAddr_(pt.DisplayName))))
    errors.push('Partner: legal/display name must be unique');

  const idx = addrIndex_();
  const labs = DB.where(SH.LABS, l => str_(l.PartnerID) === pid && ['Draft', 'Active'].indexOf(str_(l.State)) >= 0);
  const labResults = labs.map(l => labValidation_(l, idx));
  const okLabs = labs.filter((l, i) => !labResults[i].errors.length);
  const minPct = cfgNum_('MIN_MARGIN_WARNING_PCT');
  const rateLines = DB.where(SH.RATECARDS, r => str_(r.PartnerID) === pid && ['Draft', 'Active'].indexOf(str_(r.State)) >= 0);
  if (!rateLines.length) errors.push('Rate card: no Draft/Active lines');
  rateLines.forEach(r => {
    validateRateLine_(r).forEach(e => errors.push('Rate card ' + str_(r.RateCardID) + ': ' + e));
    if (num_(r.MRP) > 0 && num_(r.GynovedaMarginRs) / num_(r.MRP) * 100 < minPct) warnings.push('Rate card ' + str_(r.ItemName) + ': margin below ' + minPct + '% of MRP');
    const m = itemMeta_(r);
    const codes = m.type === 'Package' ? m.femaleCodes.concat(m.maleCodes) : [m.code];
    const uncovered = codes.filter(c => !okLabs.some(l => labPerforms_(l, c)));
    if (uncovered.length) errors.push('No valid lab performs ' + uncovered.map(codeName_).join(', ') + ' (' + m.name + ')');
  });
  DB.where(SH.CLINICS, c => str_(c.DefaultPartnerID) === pid && ['Active', 'Staged'].indexOf(str_(c.Status)) >= 0).forEach(c => {
    if (!okLabs.some(l => splitList_(l.ClinicIDServed).indexOf(str_(c.ClinicID)) >= 0)) errors.push('Clinic ' + c.Name + ' has no valid serving lab');
  });
  return {
    partnerId: pid, name: partnerName_(pid), state: str_(pt.State), errors: uniq_(errors), warnings: uniq_(warnings),
    labs: labResults, labsOk: okLabs.length, labsWithErrors: labResults.filter(r => r.errors.length).length,
    rateLines: rateLines.length
  };
}

function partnerActivate_(ctx, p) {
  const c = p.checklist || {};
  need_(c.agreement && c.ratecard && c.nabl && c.testcall, 'Complete the 4-point verification checklist (agreement, rate card, NABL, test call).');
  const v = partnerValidation_(ctx, p);
  need_(!v.errors.length, 'Blocking errors must be fixed first: ' + v.errors.slice(0, 8).join('; ') + (v.errors.length > 8 ? '…' : ''));
  if (v.warnings.length || v.labs.some(l => l.warnings.length)) need_(str_(p.note).length >= 5, 'Warnings need a mandatory Admin sign-off note.');
  const pt = partner_(p.partnerId);
  const now = todayIST_();
  const before = { State: str_(pt.State) };
  pt.State = 'Active';
  if (!str_(pt.EffectiveDate)) pt.EffectiveDate = now;
  DB.update(SH.PARTNERS, pt);
  const okIds = v.labs.filter(l => !l.errors.length).map(l => l.labId);
  const labs = DB.where(SH.LABS, l => okIds.indexOf(str_(l.LabID)) >= 0 && str_(l.State) === 'Draft');
  labs.forEach(l => { l.State = 'Active'; });
  DB.updateMany(SH.LABS, labs);
  const lines = DB.where(SH.RATECARDS, r => str_(r.PartnerID) === str_(pt.PartnerID) && str_(r.State) === 'Draft');
  lines.forEach(r => { r.State = 'Active'; });
  DB.updateMany(SH.RATECARDS, lines);
  audit_(ctx, 'PARTNER_ACTIVATED', '', 'Partner', pt.PartnerID, before, { State: 'Active', labsActivated: labs.length, rateLinesActivated: lines.length }, str_(p.note));
  return { partnerId: pt.PartnerID, labsActivated: labs.length, rateLinesActivated: lines.length };
}

function partnerSetState_(ctx, p) {
  const pt = partner_(p.partnerId);
  need_(pt, 'Partner not found.');
  need_(['Suspended', 'Draft'].indexOf(p.state) >= 0, 'Invalid state.');
  need_(str_(p.note).length >= 5, 'A reason is mandatory.');
  const before = { State: str_(pt.State) };
  pt.State = p.state;
  if (p.state === 'Draft') pt.Notes = str_(pt.Notes) + ' · Rejected ' + todayIST_() + ': ' + str_(p.note);
  DB.update(SH.PARTNERS, pt);
  audit_(ctx, p.state === 'Suspended' ? 'PARTNER_SUSPENDED' : 'PARTNER_REJECTED', '', 'Partner', pt.PartnerID, before, { State: p.state }, p.note);
  const affected = DB.where(SH.CLINICS, c => str_(c.DefaultPartnerID) === str_(pt.PartnerID) && str_(c.Status) === 'Active').map(c => c.Name);
  return { partnerId: pt.PartnerID, clinicsBlocked: affected };
}

/** Bulk-activate Draft labs of an Active partner (e.g. Gujarat labs). Labs with errors are skipped. */
function labsActivate_(ctx, p) {
  const ids = Array.isArray(p.labIds) ? p.labIds : [];
  need_(ids.length, 'Select at least one lab.');
  const idx = addrIndex_();
  const done = [], skipped = [];
  let needNote = false;
  const toUpdate = [];
  ids.forEach(id => {
    const l = lab_(id);
    if (!l) { skipped.push({ labId: id, why: 'not found' }); return; }
    const pt = partner_(l.PartnerID);
    if (!pt || str_(pt.State) !== 'Active') { skipped.push({ labId: id, why: 'partner not Active — use partner Validate & Activate' }); return; }
    if (str_(l.State) === 'Active') { skipped.push({ labId: id, why: 'already Active' }); return; }
    const v = labValidation_(l, idx);
    if (v.errors.length) { skipped.push({ labId: id, why: v.errors.join('; ') }); return; }
    if (v.warnings.length) needNote = true;
    toUpdate.push(l);
  });
  if (needNote) need_(str_(p.note).length >= 5, 'Some labs have warnings (e.g. blank NABL). Add an Admin sign-off note.');
  toUpdate.forEach(l => { l.State = 'Active'; done.push(str_(l.LabID)); });
  DB.updateMany(SH.LABS, toUpdate);
  if (done.length) audit_(ctx, 'LABS_ACTIVATED', '', 'Labs', done.join(','), null, { count: done.length }, str_(p.note));
  return { activated: done, skipped: skipped };
}

function labSetState_(ctx, p) {
  const l = lab_(p.labId); need_(l, 'Lab not found.');
  need_(['Suspended', 'Draft'].indexOf(p.state) >= 0, 'Invalid state.');
  need_(str_(p.note).length >= 3, 'A reason is mandatory.');
  const before = { State: str_(l.State) };
  l.State = p.state;
  DB.update(SH.LABS, l);
  audit_(ctx, 'LAB_STATE_CHANGED', '', 'Lab', l.LabID, before, { State: p.state }, p.note);
  return { labId: l.LabID };
}

/** Partner Coordinator "Request new lab" → Draft lab for Admin validation (BRD §12.5). */
function requestLab_(ctx, p) {
  need_(ctx.role === ROLE.PC, 'Only Partner Coordinators request new labs.');
  const l = p.lab || {};
  need_(str_(l.LabName).length >= 3, 'Enter the lab name.');
  need_(str_(l.Address).length >= 10, 'Enter the full address.');
  need_(RE_PIN.test(str_(l.Pincode)), 'Pincode must be 6 digits.');
  need_(clinic_(l.ClinicIDServed) && inClinicScope_(ctx, l.ClinicIDServed), 'Select a clinic in your scope.');
  const row = {
    LabID: nextId_(SH.LABS, 'LabID', 'LB-' + partnerShort_(ctx.partnerId) + '-', 3), PartnerID: ctx.partnerId,
    LabName: str_(l.LabName), ClinicIDServed: str_(l.ClinicIDServed), AreaName: clinicName_(l.ClinicIDServed), Address: str_(l.Address),
    Pincode: str_(l.Pincode), MapsLink: str_(l.MapsLink), LabPhone: str_(l.LabPhone), SecondaryPhone: '',
    LabManagerName: str_(l.LabManagerName), LabManagerMobile: cleanPhone_(l.LabManagerMobile), LabManagerEmail: str_(l.LabManagerEmail),
    Modes: str_(l.Modes) || 'Lab visit', HomeCollectionPincodes: str_(l.HomeCollectionPincodes), TestsPerformed: str_(l.TestsPerformed) || 'ALL_PATHOLOGY',
    NABLCertNumber: str_(l.NABLCertNumber), State: 'Draft', Notes: 'Requested by ' + ctx.name + ' on ' + todayIST_()
  };
  DB.insert(SH.LABS, row);
  audit_(ctx, 'LAB_REQUESTED', '', 'Lab', row.LabID, null, pick_(row, ['LabName', 'ClinicIDServed', 'Pincode']), '');
  const admins = DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.ADMIN).map(u => u.Email);
  sendMail_(admins, '[DCP] New lab requested · ' + row.LabName, '<p>' + escHtml_(ctx.name) + ' requested a new lab (' + escHtml_(row.LabID) + '). Validate & activate it in Admin → Partners & Labs.</p>');
  return { labId: row.LabID };
}

/* ---------- rate-card versions & staged items ---------- */
function rcNewVersion_(ctx, p) {
  const pid = str_(p.partnerId);
  need_(partner_(pid), 'Partner not found.');
  const version = str_(p.version);
  need_(/^v[\w.\-]+$/i.test(version), 'Version should look like v2.0');
  need_(!DB.rows(SH.RATECARDS).some(r => str_(r.PartnerID) === pid && str_(r.Version) === version), 'Version ' + version + ' already exists.');
  need_(isValidDateStr_(p.effectiveFrom) && p.effectiveFrom >= todayIST_(), 'EffectiveFrom must be today or later.');
  const rc = activeRateCard_(pid);
  const prefix = 'RC-' + partnerShort_(pid) + '-' + version + '-';
  const rows = Object.keys(rc).map(code => {
    const r = clone_(rc[code]);
    r.RateCardID = nextId_(SH.RATECARDS, 'RateCardID', prefix, 3);
    r.Version = version; r.EffectiveFrom = p.effectiveFrom; r.State = 'Draft'; r.CRMDiscrepancyNote = 'Copied from ' + str_(rc[code].RateCardID);
    return r;
  });
  need_(rows.length, 'No active lines to copy.');
  DB.insert(SH.RATECARDS, rows);
  audit_(ctx, 'RATECARD_VERSION_CREATED', '', 'RateCards', pid + ' ' + version, null, { lines: rows.length, effectiveFrom: p.effectiveFrom }, str_(p.note));
  return { version: version, lines: rows.length };
}

function rcActivateVersion_(ctx, p) {
  const pid = str_(p.partnerId), version = str_(p.version);
  const pt = partner_(pid);
  need_(pt && str_(pt.State) === 'Active', 'Partner must be Active (new partners activate through Validate & Activate).');
  const lines = DB.where(SH.RATECARDS, r => str_(r.PartnerID) === pid && str_(r.Version) === version && str_(r.State) === 'Draft');
  need_(lines.length, 'No Draft lines for ' + version + '.');
  const errs = [];
  lines.forEach(r => validateRateLine_(r).forEach(e => errs.push(str_(r.ItemName) + ': ' + e)));
  need_(!errs.length, errs.slice(0, 8).join('; '));
  const minPct = cfgNum_('MIN_MARGIN_WARNING_PCT');
  if (lines.some(r => num_(r.GynovedaMarginRs) / num_(r.MRP) * 100 < minPct)) need_(str_(p.note).length >= 5, 'Some margins are below ' + minPct + '% of MRP — add a sign-off note.');
  lines.forEach(r => { r.State = 'Active'; r.PartnerB2BShareRs = round2_(num_(r.PatientPrice) - num_(r.GynovedaMarginRs)); });
  DB.updateMany(SH.RATECARDS, lines);
  audit_(ctx, 'RATECARD_VERSION_ACTIVATED', '', 'RateCards', pid + ' ' + version, null, { lines: lines.length, effectiveFrom: str_(lines[0].EffectiveFrom) }, str_(p.note));
  return { activated: lines.length, effectiveFrom: str_(lines[0].EffectiveFrom) };
}

/** One-click activation of staged items (BRD §3.3): State Active + VisibleToClinics TRUE. */
function rcActivateItems_(ctx, p) {
  const ids = Array.isArray(p.rateCardIds) ? p.rateCardIds : [];
  need_(ids.length, 'Select rate-card lines.');
  const done = [], skipped = [];
  const toUpdate = [];
  ids.forEach(id => {
    const r = DB.get(SH.RATECARDS, 'RateCardID', id);
    if (!r) { skipped.push({ id: id, why: 'not found' }); return; }
    const pt = partner_(r.PartnerID);
    if (!pt || str_(pt.State) !== 'Active') { skipped.push({ id: id, why: 'partner not Active' }); return; }
    const errs = validateRateLine_(r);
    const m = itemMeta_(r);
    const labs = DB.where(SH.LABS, l => str_(l.PartnerID) === str_(r.PartnerID) && str_(l.State) === 'Active');
    const codes = m.type === 'Package' ? m.femaleCodes.concat(m.maleCodes) : [m.code];
    const unc = codes.filter(c => !labs.some(l => labPerforms_(l, c)));
    if (unc.length) errs.push('no Active lab performs ' + unc.map(codeName_).join(', '));
    if (errs.length) { skipped.push({ id: id, why: errs.join('; ') }); return; }
    r.State = 'Active'; r.VisibleToClinics = true;
    r.PartnerB2BShareRs = round2_(num_(r.PatientPrice) - num_(r.GynovedaMarginRs));
    toUpdate.push(r); done.push(id);
  });
  DB.updateMany(SH.RATECARDS, toUpdate);
  if (done.length) audit_(ctx, 'RATECARD_ITEMS_ACTIVATED', '', 'RateCards', done.join(','), null, { count: done.length }, str_(p.note));
  return { activated: done, skipped: skipped };
}

/* ---------- duplicates (BRD §14) ---------- */
function dupList_(ctx) {
  return DB.rows(SH.DUPES).map(d => {
    const o = clone_(d);
    const a = lead_(d.PrimaryLeadID), b = lead_(d.DuplicateLeadID);
    o.primaryStatus = a ? str_(a.Status) : '(not in Leads)';
    o.duplicateStatus = b ? str_(b.Status) : '(not in Leads)';
    o.clinic1Name = clinicName_(d.Clinic1); o.clinic2Name = clinicName_(d.Clinic2);
    return o;
  }).sort((x, y) => (/Pending/.test(y.ResolutionStatus) - /Pending/.test(x.ResolutionStatus)) || str_(y.DetectedAt).localeCompare(str_(x.DetectedAt)));
}

function dupResolve_(ctx, p) {
  const d = DB.get(SH.DUPES, 'ReviewID', p.reviewId);
  need_(d, 'Review not found.');
  need_(['keep', 'cancel'].indexOf(p.action) >= 0, 'Choose a resolution.');
  const note = str_(p.note);
  need_(note.length >= 3, 'A resolution note is mandatory.');
  if (p.action === 'cancel') {
    const dup = lead_(d.DuplicateLeadID);
    need_(dup, 'Duplicate lead ' + d.DuplicateLeadID + ' is not in the Leads tab.');
    const s = str_(dup.Status);
    need_([ST.DONE, ST.REPORT, ST.CLOSED, ST.DISPUTED].indexOf(s) < 0, 'The duplicate lead is already ' + s + ' — resolve it through a dispute instead.');
    if ([ST.CANCEL, ST.NI].indexOf(s) < 0) {
      const before = clone_(dup);
      dup.Status = ST.CANCEL; dup.CancelReason = 'Duplicate of ' + d.PrimaryLeadID; dup.RevenueState = REV.VOID;
      dup.StatusChangedAt = nowIST_(); dup.LastUpdatedAt = nowIST_(); dup.LastUpdatedBy = ctx.name;
      DB.update(SH.LEADS, dup);
      const df = diff_(before, dup);
      audit_(ctx, 'STATUS_CHANGE', dup.LeadID, 'Lead', s + ' → ' + ST.CANCEL, df.before, df.after, 'Duplicate resolution (' + d.ReviewID + '): ' + note);
    }
    d.ResolutionStatus = 'Resolved – Duplicate cancelled';
  } else d.ResolutionStatus = 'Resolved – Not a duplicate';
  d.ResolvedBy = ctx.name; d.ResolutionNote = note.slice(0, 300);
  DB.update(SH.DUPES, d);
  audit_(ctx, 'DUPLICATE_RESOLVED', d.DuplicateLeadID, 'DuplicateReview', d.ReviewID, null, { status: d.ResolutionStatus }, note);
  return { reviewId: d.ReviewID, status: d.ResolutionStatus };
}

/* ---------- audit reader ---------- */
function readAudit_(filterFn, limit) {
  const sh = DB.sheet(SH.AUDIT);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const h = vals[0].map(str_);
  const out = [];
  for (let i = vals.length - 1; i >= 1 && out.length < (limit || 500); i--) {
    const o = {}; h.forEach((k, j) => { if (k) o[k] = normCell_(k, vals[i][j]); });
    if (!filterFn || filterFn(o)) out.push(o);
  }
  return out;
}

function auditList_(ctx, p) {
  const lead = str_(p.leadId), action = str_(p.action), q = str_(p.q).toLowerCase();
  const rows = readAudit_(o => (!lead || str_(o.LeadID) === lead) && (!action || str_(o.Action) === action) &&
    (!q || [o.UserEmail, o.Note, o.EntityRef, o.Entity].some(v => str_(v).toLowerCase().indexOf(q) >= 0)), Math.min(Number(p.limit) || 300, 2000));
  return { rows: rows };
}

/* ---------- disputes queue ---------- */
function disputeList_(ctx) {
  const disputed = DB.where(SH.LEADS, l => str_(l.Status) === ST.DISPUTED).map(l => ({
    leadId: l.LeadID, clinic: clinicName_(l.ClinicID), partner: partnerName_(l.PartnerID), status: l.Status, since: str_(l.StatusChangedAt || l.LastUpdatedAt), kind: 'Disputed lead'
  }));
  const events = readAudit_(o => ['DISPUTE_FLAGGED', 'DISPUTE_DISMISSED', 'STATUS_CHANGE'].indexOf(str_(o.Action)) >= 0, 3000);
  const seen = {}, flags = [];
  events.forEach(e => { // newest first
    const id = str_(e.LeadID);
    if (seen[id]) return;
    if (e.Action === 'DISPUTE_DISMISSED' || (e.Action === 'STATUS_CHANGE' && /Disputed|Cancelled|Closed/.test(str_(e.EntityRef)))) { seen[id] = 1; return; }
    if (e.Action === 'DISPUTE_FLAGGED') {
      seen[id] = 1;
      const l = lead_(id);
      if (l && str_(l.Status) !== ST.DISPUTED) flags.push({ leadId: id, clinic: clinicName_(l.ClinicID), partner: partnerName_(l.PartnerID), status: l.Status, since: str_(e.Timestamp), by: str_(e.UserEmail), note: str_(e.Note), kind: 'Flag from ' + str_(e.Role) });
    }
  });
  const lines = DB.where(SH.STLINES, x => str_(x.LineStatus) === 'Flagged').map(x => ({
    leadId: x.LeadID, statementLineId: x.StatementLineID, statementId: x.StatementID, clinic: clinicName_(x.ClinicID), note: str_(x.FlagNote), kind: 'Statement line flag'
  }));
  return { disputed: disputed, flags: flags, statementFlags: lines };
}
function disputeDismiss_(ctx, p) {
  const l = mustLead_(p.leadId);
  need_(str_(p.note).length >= 3, 'Add a note.');
  audit_(ctx, 'DISPUTE_DISMISSED', l.LeadID, 'Lead', l.LeadID, null, null, p.note);
  return { leadId: l.LeadID };
}

/* ---------- config ---------- */
function configView_(ctx) {
  const props = PropertiesService.getScriptProperties();
  return {
    rows: DB.rows(SH.CONFIG).map(clone_), appUrl: appUrl_(),
    webhookUrl: appUrl_() ? appUrl_() + '?hook=msg&key=' + (props.getProperty('MSG_WEBHOOK_KEY') || '(run setup)') : '',
    apiConfigured: !!props.getProperty('MSG_API_URL'),
    reportsFolder: props.getProperty('REPORTS_FOLDER_ID') || '', backupsFolder: props.getProperty('BACKUPS_FOLDER_ID') || '',
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction())
  };
}
function setMsgApi_(ctx, p) {
  const props = PropertiesService.getScriptProperties();
  if (p.url !== undefined) { need_(!p.url || /^https:\/\//.test(p.url), 'API URL must start with https:\/\/'); props.setProperty('MSG_API_URL', str_(p.url)); }
  if (p.token) props.setProperty('MSG_API_TOKEN', str_(p.token));
  if (p.rotateWebhookKey) props.setProperty('MSG_WEBHOOK_KEY', randomHex_(16));
  audit_(ctx, 'MSG_API_CONFIGURED', '', 'Config', 'MSG_API', null, { url: !!p.url, token: !!p.token, rotated: !!p.rotateWebhookKey }, '');
  return configView_(ctx);
}

/* ---------- exports (Admin only, BRD §14) ---------- */
function csv_(headers, rows) {
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.map(esc).join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n');
}
function exportTable_(ctx, p) {
  const table = str_(p.table);
  const allowed = Object.keys(MD_TABLES).concat([SH.LEADS, SH.LEADTESTS, SH.STATEMENTS, SH.STLINES, SH.TRANSFERS, SH.ALLOCATIONS, SH.DUPES, SH.MESSAGES, SH.REPORTS]);
  need_(allowed.indexOf(table) >= 0 || table === SH.AUDIT, 'This tab can\'t be exported.');
  let headers, rows;
  if (table === SH.AUDIT) { rows = readAudit_(null, 50000); headers = rows.length ? Object.keys(rows[0]) : []; }
  else {
    headers = DB.headers(table).filter(Boolean);
    rows = DB.rows(table);
    if (table === SH.LEADS && (p.from || p.to || p.status || p.clinicId || p.partnerId || p.labId || p.urgency || p.regionId || p.areaId)) {
      rows = rows.filter(l => {
        if (p.status && str_(l.Status) !== p.status) return false;
        if (p.clinicId && str_(l.ClinicID) !== p.clinicId) return false;
        if (p.partnerId && str_(l.PartnerID) !== p.partnerId) return false;
        if (p.labId && str_(l.AssignedLabID) !== p.labId) return false;
        if (p.urgency && (str_(l.Urgency) || 'Normal') !== p.urgency) return false;
        if (p.from && str_(l.CreatedAt).slice(0, 10) < p.from) return false;
        if (p.to && str_(l.CreatedAt).slice(0, 10) > p.to) return false;
        if (p.regionId || p.areaId) {
          const cl = clinic_(l.ClinicID);
          if (p.regionId && (!cl || str_(cl.RegionID) !== p.regionId)) return false;
          if (p.areaId && (!cl || str_(cl.AreaID) !== p.areaId)) return false;
        }
        return true;
      });
    }
  }
  audit_(ctx, 'EXPORT', '', table, String(rows.length) + ' rows', null, null, JSON.stringify(p));
  return { fileName: 'DCP_' + table + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm') + '.csv', csv: csv_(headers, rows) };
}

/* ---------- footfall & adoption (BRD §11.1) ---------- */
function footfallRecompute_(ctx, p) {
  const month = str_(p.month);
  need_(/^\d{4}-\d{2}$/.test(month), 'Select a month.');
  const rows = DB.where(SH.FOOTFALL, r => str_(r.MonthYYYYMM) === month);
  need_(rows.length, 'No ClinicFootfall rows for ' + month + '. Add each clinic\'s 1Cx footfall first.');
  const legacy = rows.filter(r => !/DCP app/.test(str_(r.DataSource)) && str_(r.DCPLeads) !== '');
  if (legacy.length && !p.force) fail_(legacy.length + ' row(s) for ' + month + ' hold figures imported from another source. Tick "overwrite" to replace them with DCP app numbers.');
  const target = cfgNum_('KPI_TARGET_ADOPTION_PCT') / 100;
  rows.forEach(r => {
    const leads = DB.where(SH.LEADS, l => str_(l.ClinicID) === str_(r.ClinicID) && str_(l.CreatedAt).slice(0, 7) === month);
    const done = leads.filter(l => str_(l.TestDoneAt));
    r.DCPLeads = leads.length;
    r.TestDoneCount = done.length;
    r.ConversionPct = leads.length ? round2_(done.length / leads.length * 10000) / 10000 : 0;
    r.AdoptionPct = num_(r.Footfall1Cx) > 0 ? round2_(leads.length / num_(r.Footfall1Cx) * 10000) / 10000 : '';
    r.TargetAdoptionPct = target;
    r.EarnedCommissionRs = round2_(DB.where(SH.LEADS, l => str_(l.ClinicID) === str_(r.ClinicID) && str_(l.TestDoneAt).slice(0, 7) === month &&
      [REV.EARNED, REV.OUTSTANDING, REV.COLLECTED].indexOf(str_(l.RevenueState)) >= 0).reduce((a, l) => a + num_(l.ExpectedMarginRs), 0));
    r.DataSource = 'DCP app (' + todayIST_() + ')';
  });
  DB.updateMany(SH.FOOTFALL, rows);
  audit_(ctx, 'FOOTFALL_RECOMPUTED', '', 'ClinicFootfall', month, null, { rows: rows.length }, '');
  return { month: month, rows: rows.length };
}

/* ----------------------------------------------------------------------------
 *  DPDP retention & erasure
 *  Patient PII is scrubbed from closed leads once they pass the retention
 *  window, and on demand when a patient exercises their right to erasure.
 *  Business/analytics fields (dates, status, clinic, partner, amounts, age,
 *  gender, pincode) are deliberately kept — they carry no direct identifier
 *  and the KPI, commission and footfall reports depend on them.
 *  Diagnostic report PDFs in Drive are NOT touched: deleting clinical records
 *  is a separate decision with its own retention obligations.
 * --------------------------------------------------------------------------*/
const PII_REDACTED_ = '[redacted]';
const PII_TERMINAL_ST_ = [ST.CLOSED, ST.CANCEL, ST.NI];

function piiPurged_(lead) { return str_(lead.PatientName) === PII_REDACTED_; }

/** Date a lead became final — ClosedAt if set, else the last status change. */
function leadTerminalDate_(lead) {
  return str_(lead.ClosedAt).slice(0, 10) || str_(lead.StatusChangedAt).slice(0, 10);
}

/** Scrubs direct identifiers from the given leads and their linked rows. */
function scrubLeadsPii_(leads) {
  if (!leads.length) return 0;
  const ids = {};
  leads.forEach(l => {
    ids[str_(l.LeadID)] = 1;
    if (str_(l.PatientName)) l.PatientName = PII_REDACTED_;
    if (str_(l.SpouseName)) l.SpouseName = PII_REDACTED_;
    l.Phone = '';
    l.CollectionAddress = '';
  });
  DB.updateMany(SH.LEADS, leads);

  const msgs = DB.where(SH.MESSAGES, m => ids[str_(m.LeadID)] && str_(m.RecipientPhone));
  if (msgs.length) { msgs.forEach(m => { m.RecipientPhone = ''; }); DB.updateMany(SH.MESSAGES, msgs); }

  const dupes = DB.where(SH.DUPES, d => ids[str_(d.PrimaryLeadID)] || ids[str_(d.DuplicateLeadID)]);
  if (dupes.length) {
    dupes.forEach(d => { if (str_(d.PatientName)) d.PatientName = PII_REDACTED_; d.Phone = ''; });
    DB.updateMany(SH.DUPES, dupes);
  }
  resetGroups_();
  return leads.length;
}

/**
 * Scheduled scrub (runs from weeklyBackup, after the snapshot is taken).
 * Off until an Admin sets PII_RETENTION_ENABLED — the app never destroys data
 * on a default nobody chose.
 */
function purgePii_() {
  if (!cfgBool_('PII_RETENTION_ENABLED')) return { enabled: false, purged: 0 };
  const months = cfgNum_('PII_RETENTION_MONTHS') || 24;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const cutoff = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');

  const due = DB.where(SH.LEADS, l => {
    if (piiPurged_(l)) return false;
    if (PII_TERMINAL_ST_.indexOf(str_(l.Status)) < 0) return false;
    const t = leadTerminalDate_(l);
    return !!t && t < cutoff;
  });
  const n = scrubLeadsPii_(due);
  if (n) audit_(null, 'PII_PURGED', '', 'Leads', 'retention', null,
    { leads: n, retentionMonths: months, closedBefore: cutoff }, 'Scheduled DPDP retention scrub');
  return { enabled: true, purged: n, cutoff: cutoff, retentionMonths: months };
}

/**
 * On-demand erasure for a DPDP request (BRD §15 data-principal rights).
 * Only the last 4 digits of the number are recorded in Audit — writing the
 * full number into the log would put back what the patient asked us to remove.
 */
function erasePatient_(ctx, p) {
  const phone = cleanPhone_(p.phone);
  need_(RE_PHONE.test(phone), 'Enter the patient\'s 10-digit mobile number.');
  const leads = DB.where(SH.LEADS, l => cleanPhone_(l.Phone) === phone && !piiPurged_(l));
  need_(leads.length, 'No leads found for that number (it may already have been erased).');
  const open = leads.filter(l => PII_TERMINAL_ST_.indexOf(str_(l.Status)) < 0);
  if (open.length && p.confirmOpen !== true) {
    fail_(open.length + ' of these ' + leads.length + ' lead(s) are still in progress (' +
      uniq_(open.map(l => str_(l.Status))).join(', ') + '). Erasing now means the lab can no longer contact the patient. ' +
      'Tick the confirmation to erase anyway.', 'ERASE_OPEN_LEADS');
  }
  const ids = leads.map(l => str_(l.LeadID));
  const n = scrubLeadsPii_(leads);
  audit_(ctx, 'PII_ERASED', '', 'Leads', 'erasure-request', null,
    { leads: n, openAtErasure: open.length, phone: '••••••' + phone.slice(-4) },
    'DPDP erasure request · ' + ids.join(', ') + (str_(p.note) ? ' · ' + str_(p.note) : ''));
  return { erased: n, leadIds: ids, openAtErasure: open.length };
}
/* ============================================================================
 *  DASHBOARD & KPIs (BRD §1.3, §9.1)
 * ==========================================================================*/

const FUNNEL = [ST.GEN, ST.CALLED, ST.BOOKED, ST.SAMPLE, ST.DONE, ST.REPORT, ST.CLOSED];

/** Furthest funnel stage a lead reached (0–6). */
function stageRank_(l) {
  const s = str_(l.Status);
  switch (s) {
    case ST.GEN: case ST.NR: return 0;
    case ST.CALLED: case ST.FU_AP: case ST.FU_WDL: case ST.NI: return 1;
    case ST.BOOKED: case ST.LABVISIT: case ST.HOME: return 2;
    case ST.SAMPLE: return 3;
    case ST.DONE: case ST.DISPUTED: return 4;
    case ST.REPORT: return 5;
    case ST.CLOSED: return 6;
    case ST.CANCEL:
      if (str_(l.TestDoneAt)) return 4;
      if (str_(l.SampleCollectedAt)) return 3;
      if (str_(l.AssignedLabID)) return 2;
      return /No response|Wrong number/.test(str_(l.CancelReason)) ? 0 : 1;
  }
  return 0;
}

function geoFilter_(p) {
  return l => {
    if (p.partnerId && str_(l.PartnerID) !== p.partnerId) return false;
    if (p.clinicId && str_(l.ClinicID) !== p.clinicId) return false;
    if (p.areaId || p.regionId) {
      const c = clinic_(l.ClinicID);
      if (!c) return false;
      if (p.areaId && str_(c.AreaID) !== p.areaId) return false;
      if (p.regionId && str_(c.RegionID) !== p.regionId) return false;
    }
    return true;
  };
}
const pct_ = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);

function dashSummary_(ctx, p) {
  p = p || {};
  const now = new Date(), today = fmtD_(now);
  const to = str_(p.to) || today;
  const from = str_(p.from) || addDaysStr_(to, -29);
  const month = str_(p.month) || to.slice(0, 7);
  const geo = geoFilter_(p);
  const all = DB.rows(SH.LEADS).filter(geo);
  const cohort = all.filter(l => { const c = str_(l.CreatedAt).slice(0, 10); return c >= from && c <= to; });

  // Funnel & statuses
  const funnel = FUNNEL.map((s, i) => ({ stage: s, count: cohort.filter(l => stageRank_(l) >= i).length }));
  funnel.forEach((f, i) => { f.pctOfLeads = pct_(f.count, cohort.length); f.stepPct = i ? pct_(f.count, funnel[i - 1].count) : 100; });
  const statusCounts = {};
  cohort.forEach(l => { statusCounts[l.Status] = (statusCounts[l.Status] || 0) + 1; });

  // KPI 2: Lead → Test done
  const done = cohort.filter(l => stageRank_(l) >= 4);
  // KPI 3: Report on time (test done in range, TAT window elapsed or reported)
  const tdRange = all.filter(l => { const d = str_(l.TestDoneAt).slice(0, 10); return d && d >= from && d <= to; });
  let onTime = 0, rtDen = 0;
  const tats = [];
  tdRange.forEach(l => {
    const tat = reportTatHours_(l, leadLines_(l.LeadID));
    const td = parseDT_(l.TestDoneAt), rg = parseDT_(l.ReportGeneratedAt);
    if (rg) { const h = (rg - td) / 3600000; tats.push(h); rtDen++; if (h <= tat) onTime++; }
    else if ((now - td) / 3600000 > tat) rtDen++;
  });
  // KPI 1: Adoption (month)
  const ffRows = DB.where(SH.FOOTFALL, r => str_(r.MonthYYYYMM) === month && num_(r.Footfall1Cx) > 0 &&
    (!p.clinicId || str_(r.ClinicID) === p.clinicId) && geo({ ClinicID: r.ClinicID, PartnerID: p.partnerId || (clinic_(r.ClinicID) || {}).DefaultPartnerID }));
  const ffSum = ffRows.reduce((a, r) => a + num_(r.Footfall1Cx), 0);
  const ffClinics = ffRows.map(r => str_(r.ClinicID));
  const monthLeads = all.filter(l => str_(l.CreatedAt).slice(0, 7) === month && ffClinics.indexOf(str_(l.ClinicID)) >= 0).length;
  // KPI 4: Commission
  const sumMargin = arr => round2_(arr.reduce((a, l) => a + num_(l.ExpectedMarginRs), 0));
  const byRev = {};
  all.forEach(l => { const r = str_(l.RevenueState) || REV.EXPECTED; byRev[r] = round2_((byRev[r] || 0) + num_(l.ExpectedMarginRs)); });
  const earnedInRange = sumMargin(tdRange.filter(l => [REV.EARNED, REV.OUTSTANDING, REV.COLLECTED, REV.FROZEN].indexOf(str_(l.RevenueState)) >= 0));
  const partnerIds = p.partnerId ? [p.partnerId] : DB.rows(SH.PARTNERS).map(x => str_(x.PartnerID));
  const stmtIds = {};
  DB.where(SH.STATEMENTS, s => partnerIds.indexOf(str_(s.PartnerID)) >= 0).forEach(s => { stmtIds[str_(s.StatementID)] = 1; });
  const stLines = DB.where(SH.STLINES, l => stmtIds[str_(l.StatementID)] && LINE_EXCLUDED.indexOf(str_(l.LineStatus)) < 0);
  const alloc = allocatedByLine_();
  const stEarned = round2_(stLines.reduce((a, l) => a + num_(l.ContractualMarginRs), 0));
  const stCollected = round2_(stLines.reduce((a, l) => a + Math.min(num_(l.ContractualMarginRs), alloc[allocKey_(l.StatementID, l.LeadID)] || 0), 0));
  const collectedInRange = round2_(DB.rows(SH.ALLOCATIONS).filter(a => stmtIds[str_(a.StatementID)] && str_(a.AllocatedAt).slice(0, 10) >= from && str_(a.AllocatedAt).slice(0, 10) <= to)
    .reduce((s, a) => s + num_(a.AllocatedAmountRs), 0));
  // KPI 5: CSAT
  const leadIds = {};
  all.forEach(l => { leadIds[str_(l.LeadID)] = 1; });
  const ratings = DB.rows(SH.MESSAGES).filter(m => str_(m.TemplateCode) === 'M9-REPLY' && leadIds[str_(m.LeadID)] &&
    str_(m.SentAt).slice(0, 10) >= from && str_(m.SentAt).slice(0, 10) <= to).map(m => Number(str_(m.Status).replace('rating:', ''))).filter(n => n >= 1 && n <= 5);

  const kpis = [
    { key: 'adoption', label: 'Adoption % (' + month + ')', value: ffSum ? pct_(monthLeads, ffSum) : null, target: cfgNum_('KPI_TARGET_ADOPTION_PCT'),
      detail: ffSum ? monthLeads + ' DCP leads ÷ ' + ffSum + ' 1Cx footfall (' + ffRows.length + ' clinics)' : 'Enter ' + month + ' 1Cx footfall in ClinicFootfall' },
    { key: 'conversion', label: 'Lead → Test done %', value: pct_(done.length, cohort.length), target: cfgNum_('KPI_TARGET_CONVERSION_PCT'), detail: done.length + ' of ' + cohort.length + ' leads' },
    { key: 'ontime', label: 'Report on time %', value: pct_(onTime, rtDen), target: cfgNum_('KPI_TARGET_REPORT_ONTIME_PCT'), detail: onTime + ' of ' + rtDen + ' due reports within TAT' },
    { key: 'collection', label: 'Commission collected %', value: pct_(stCollected, stEarned), target: cfgNum_('KPI_TARGET_COLLECTION_PCT'), detail: '₹' + inr_(stCollected) + ' of ₹' + inr_(stEarned) + ' on statements' },
    { key: 'csat', label: 'Patient satisfaction %', value: ratings.length ? pct_(ratings.filter(r => r >= 4).length, ratings.length) : null, target: cfgNum_('KPI_TARGET_CSAT_PCT'), detail: ratings.length ? ratings.length + ' M9 replies' : 'No M9 replies recorded yet' }
  ];
  kpis.forEach(k => { k.status = k.value === null ? 'na' : k.value >= k.target ? 'good' : k.value >= k.target * 0.75 ? 'warn' : 'bad'; });

  // SLA breaches (all open leads in geo filter)
  const breaches = [];
  all.forEach(l => {
    if (TERMINAL_ST.indexOf(str_(l.Status)) >= 0) return;
    const s = slaInfo_(l, leadLines_(l.LeadID), now);
    if (s.breached || s.escalate) breaches.push({ id: l.LeadID, clinic: clinicName_(l.ClinicID), partner: partnerName_(l.PartnerID), status: l.Status, stage: s.stage, hours: s.hours, target: s.target, label: s.label, escalate: !!s.escalate });
  });
  breaches.sort((a, b) => (b.hours || 0) - (a.hours || 0));
  const breachByStage = {};
  breaches.forEach(b => { breachByStage[b.stage] = (breachByStage[b.stage] || 0) + 1; });

  // Scorecards
  const card = (keyFn, nameFn) => {
    const g = {};
    cohort.forEach(l => { const k = keyFn(l); if (!k) return; (g[k] = g[k] || []).push(l); });
    return Object.keys(g).map(k => {
      const ls = g[k], d = ls.filter(l => stageRank_(l) >= 4);
      const rt = ls.filter(l => str_(l.ReportGeneratedAt) && str_(l.TestDoneAt)).map(l => (parseDT_(l.ReportGeneratedAt) - parseDT_(l.TestDoneAt)) / 3600000);
      const reasons = {};
      ls.filter(l => [ST.CANCEL, ST.NI].indexOf(str_(l.Status)) >= 0).forEach(l => { const r = str_(l.CancelReason).split(' of ')[0].split(':')[0] || 'Unspecified'; reasons[r] = (reasons[r] || 0) + 1; });
      const ids = {}; ls.forEach(l => { ids[l.LeadID] = 1; });
      const rr = DB.rows(SH.MESSAGES).filter(m => str_(m.TemplateCode) === 'M9-REPLY' && ids[str_(m.LeadID)]).map(m => Number(str_(m.Status).replace('rating:', ''))).filter(n => n >= 1);
      return {
        id: k, name: nameFn(k), leads: ls.length, testDone: d.length, conversion: pct_(d.length, ls.length),
        medianReportTatH: rt.length ? Math.round(median_(rt) * 10) / 10 : null,
        cancellations: Object.keys(reasons).map(r => ({ reason: r, count: reasons[r] })).sort((a, b) => b.count - a.count).slice(0, 4),
        csat: rr.length ? Math.round(rr.reduce((a, b) => a + b, 0) / rr.length * 10) / 10 : null,
        margin: ctx.role === ROLE.ADMIN ? sumMargin(d) : undefined
      };
    }).sort((a, b) => b.leads - a.leads);
  };
  const partners = card(l => str_(l.PartnerID), partnerName_);
  const labs = card(l => str_(l.AssignedLabID), labName_);
  const clinics = card(l => str_(l.ClinicID), clinicName_).map(c => {
    const ff = DB.where(SH.FOOTFALL, r => str_(r.ClinicID) === c.id && str_(r.MonthYYYYMM) === month)[0];
    const ml = all.filter(l => str_(l.ClinicID) === c.id && str_(l.CreatedAt).slice(0, 7) === month).length;
    c.adoption = ff && num_(ff.Footfall1Cx) > 0 ? pct_(ml, num_(ff.Footfall1Cx)) : null;
    c.doctors = uniq_(cohort.filter(l => str_(l.ClinicID) === c.id).map(l => str_(l.ReferringDoctor))).length;
    const cl = clinic_(c.id);
    c.state = cl ? str_(cl.State) || 'Other' : 'Other';
    c.city = cl ? str_(cl.City) || 'Other' : 'Other';
    return c;
  });
  // Geo rollups (BRD §9.1 extension): same metrics, grouped by State then City, for the dashboard's geo view.
  const geoCard = level => {
    const g = {};
    clinics.forEach(c => {
      const k = level === 'state' ? c.state : c.state + ' | ' + c.city;
      (g[k] = g[k] || { key: k, state: c.state, city: level === 'city' ? c.city : undefined, leads: 0, testDone: 0, margin: 0, clinicCount: 0, _ff: 0, _ml: 0 }).leads += c.leads;
      g[k].testDone += c.testDone; g[k].margin += (c.margin || 0); g[k].clinicCount += 1;
    });
    return Object.keys(g).map(k => {
      const r = g[k];
      return { state: r.state, city: r.city, leads: r.leads, testDone: r.testDone, conversion: pct_(r.testDone, r.leads), clinicCount: r.clinicCount, margin: ctx.role === ROLE.ADMIN ? round2_(r.margin) : undefined };
    }).sort((a, b) => b.leads - a.leads);
  };
  const byState = geoCard('state');
  const byCity = geoCard('city');

  // Trends: last 12 weeks of capture; revenue last 6 months
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = addDaysStr_(today, -7 * i), start = addDaysStr_(end, -6);
    weeks.push({ week: start, leads: all.filter(l => { const c = str_(l.CreatedAt).slice(0, 10); return c >= start && c <= end; }).length,
      testDone: all.filter(l => { const c = str_(l.TestDoneAt).slice(0, 10); return c && c >= start && c <= end; }).length });
  }
  const months = [];
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  for (let i = 5; i >= 0; i--) {
    let y = ty, m = tm - i;
    while (m < 1) { m += 12; y -= 1; }
    const ym = y + '-' + String(m).padStart(2, '0');
    months.push({ month: ym,
      earned: sumMargin(all.filter(l => str_(l.TestDoneAt).slice(0, 7) === ym && [REV.EARNED, REV.OUTSTANDING, REV.COLLECTED, REV.FROZEN].indexOf(str_(l.RevenueState)) >= 0)),
      collected: round2_(DB.rows(SH.ALLOCATIONS).filter(a => stmtIds[str_(a.StatementID)] && str_(a.AllocatedAt).slice(0, 7) === ym).reduce((s, a) => s + num_(a.AllocatedAmountRs), 0)) });
  }

  return {
    range: { from: from, to: to, month: month }, totals: { leads: cohort.length, open: all.filter(l => TERMINAL_ST.indexOf(str_(l.Status)) < 0).length },
    kpis: kpis, funnel: funnel, statusCounts: statusCounts,
    revenue: { byState: byRev, earnedInRange: earnedInRange, collectedInRange: collectedInRange, statementEarned: stEarned, statementCollected: stCollected, outstanding: round2_(stEarned - stCollected), months: months },
    breaches: breaches.slice(0, 150), breachCount: breaches.length, breachByStage: breachByStage,
    partners: partners, labs: labs.slice(0, 40), clinics: clinics, byState: byState, byCity: byCity, weeks: weeks,
    medianReportTatH: tats.length ? Math.round(median_(tats) * 10) / 10 : null,
    pendingDuplicates: DB.rows(SH.DUPES).filter(d => /Pending/.test(str_(d.ResolutionStatus))).length,
    disputed: DB.rows(SH.LEADS).filter(l => str_(l.Status) === ST.DISPUTED).length
  };
}
/* ============================================================================
 *  SCHEDULED JOBS (BRD §4.5, §8, §9.5, §10.6) and ONE-TIME SETUP
 * ==========================================================================*/

const TRIGGER_FNS = ['dailyDigest', 'eveningReminders', 'weeklySummary', 'weeklyBackup'];

function systemCtx_() {
  return { userId: 'SYSTEM', email: 'system', name: 'System', role: ROLE.ADMIN, scopeType: 'ALL', scopeIds: [], clinicScope: null, labIds: [], clinicIds: [], partnerId: '' };
}
function adminEmails_() {
  return uniq_(DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.ADMIN).map(u => str_(u.Email)).concat([cfgStr_('ADMIN_OWNER_EMAIL')]).filter(Boolean));
}
function freshRun_() { DB.reset(); resetGroups_(); CFG_ = null; }

function digestRows_(title, rows, cols) {
  if (!rows.length) return '';
  return '<h3 style="margin:16px 0 6px;font:600 14px Arial">' + escHtml_(title) + ' (' + rows.length + ')</h3>' +
    '<table cellpadding="5" style="border-collapse:collapse;font:12px Arial">' +
    '<tr>' + cols.map(c => '<th style="text-align:left;border-bottom:1px solid #ccc">' + escHtml_(c[0]) + '</th>').join('') + '</tr>' +
    rows.slice(0, 60).map(r => '<tr>' + cols.map(c => '<td style="border-bottom:1px solid #eee">' + escHtml_(r[c[1]]) + '</td>').join('') + '</tr>').join('') +
    (rows.length > 60 ? '<tr><td colspan="' + cols.length + '">… and ' + (rows.length - 60) + ' more in the app</td></tr>' : '') + '</table>';
}

/** 9:00 AM IST — SLA breaches, follow-ups due, retries, escalations (BRD §4.5, §8.2). */
function dailyDigest() {
  freshRun_();
  const now = new Date(), today = fmtD_(now);
  const open = DB.rows(SH.LEADS).filter(l => TERMINAL_ST.indexOf(str_(l.Status)) < 0);
  const rows = open.map(l => {
    const lines = leadLines_(l.LeadID), s = slaInfo_(l, lines, now);
    const pend = pendingLines_(lines);
    const sampleAge = str_(l.SampleCollectedAt) ? daysBetweenDates_(str_(l.SampleCollectedAt).slice(0, 10), today) : null;
    return { lead: l, s: s, id: l.LeadID, clinic: clinicName_(l.ClinicID), partner: partnerName_(l.PartnerID), status: l.Status,
      label: s.label, pend: pend.length, stalled: str_(l.Status) === ST.SAMPLE && pend.length && sampleAge !== null && sampleAge >= cfgNum_('PENDING_TEST_MAX_DAYS') };
  });
  const sets = r => ({
    breached: r.filter(x => x.s.breached),
    fu: r.filter(x => x.s.due && (FOLLOWUP_ST.indexOf(x.status) >= 0 || x.status === ST.CALLED)),
    retry: r.filter(x => x.status === ST.NR && x.s.due && !x.s.escalate),
    esc: r.filter(x => x.s.escalate),
    stalled: r.filter(x => x.stalled)
  });
  const cols = [['Lead', 'id'], ['Clinic', 'clinic'], ['Status', 'status'], ['SLA', 'label']];
  const url = appUrl_();
  const footer = '<p style="font:12px Arial;color:#666">Open the DCP app' + (url ? ': <a href="' + escHtml_(url) + '">' + escHtml_(url) + '</a>' : '') + '</p>';

  // Admin digest
  const a = sets(rows);
  const dupes = DB.rows(SH.DUPES).filter(d => /Pending/.test(str_(d.ResolutionStatus))).length;
  const disputed = rows.filter(x => x.status === ST.DISPUTED).length;
  const dom = Number(today.slice(8, 10));
  const html = '<div style="font:13px Arial">' +
    '<p><b>DCP daily SLA digest · ' + today + '</b></p>' +
    '<p>Open leads: ' + open.length + ' · SLA breached: ' + a.breached.length + ' · Follow-ups due: ' + a.fu.length +
    ' · Retries due: ' + a.retry.length + ' · Escalations: ' + a.esc.length + ' · Pending tests ≥' + cfgNum_('PENDING_TEST_MAX_DAYS') + 'd: ' + a.stalled.length +
    ' · Duplicates to review: ' + dupes + ' · Disputed: ' + disputed + '</p>' +
    (dom <= 3 ? '<p><b>Reminder:</b> generate last month\'s partner statements by the 3rd (Admin → Settlement).</p>' : '') +
    digestRows_('SLA breached', a.breached, cols) + digestRows_('Escalations (unreachable ' + cfgNum_('UNREACHABLE_CANCEL_DAYS') + '+ days / wrong number)', a.esc, cols) +
    digestRows_('Pending tests past ' + cfgNum_('PENDING_TEST_MAX_DAYS') + ' days — drop the test or cancel', a.stalled, cols) +
    digestRows_('Follow-ups due', a.fu, cols) + footer + '</div>';
  sendMail_(adminEmails_(), '[DCP] Daily SLA digest · ' + a.breached.length + ' breached · ' + today, html);

  // Coordinator digests (own partner + scope only)
  DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.PC).forEach(u => {
    const cx = buildCtx_(u);
    const mine = sets(rows.filter(x => canSeeLead_(cx, x.lead)));
    const total = mine.breached.length + mine.fu.length + mine.retry.length;
    if (!total) return;
    sendMail_(u.Email, '[DCP] Your queue today · ' + mine.breached.length + ' overdue · ' + mine.fu.length + ' follow-ups',
      '<div style="font:13px Arial"><p>Good morning ' + escHtml_(u.Name) + ',</p>' +
      digestRows_('Overdue (SLA breached)', mine.breached, cols) + digestRows_('Follow-ups due today', mine.fu, cols) +
      digestRows_('Retries due', mine.retry, cols) + footer + '</div>');
  });

  // API mode: automatic M7 / M9 / M-REM (MANUAL mode surfaces these in the Reminders tab)
  if (cfgStr_('MSG_MODE') === 'API') {
    withLock_(function () {
      const sys = systemCtx_();
      remindersDue_(sys, open.concat(DB.rows(SH.LEADS).filter(l => str_(l.Status) === ST.REPORT || str_(l.Status) === ST.CLOSED)), now)
        .filter(r => r.code !== 'M4').forEach(r => { const l = lead_(r.leadId); autoSendIfApi_(sys, r.code, l, leadLines_(l.LeadID)); });
    });
  }
}

/** 6:00 PM IST — evening-before reminders (M4). */
function eveningReminders() {
  freshRun_();
  const tomorrow = addDaysStr_(todayIST_(), 1);
  const appts = DB.rows(SH.LEADS).filter(l => SCHEDULED_ST.indexOf(str_(l.Status)) >= 0 && str_(l.ApptDate).slice(0, 10) === tomorrow);
  if (!appts.length) return;
  if (cfgStr_('MSG_MODE') === 'API') {
    withLock_(function () { const sys = systemCtx_(); appts.forEach(l => autoSendIfApi_(sys, 'M4', l, leadLines_(l.LeadID))); });
    return;
  }
  DB.rows(SH.USERS).filter(u => bool_(u.Active) && str_(u.Role) === ROLE.PC).forEach(u => {
    const cx = buildCtx_(u);
    const mine = appts.filter(l => canSeeLead_(cx, l)).map(l => ({ id: l.LeadID, clinic: clinicName_(l.ClinicID), lab: labName_(l.AssignedLabID), slot: str_(l.ApptSlot), mode: str_(l.BookingMode) }));
    if (!mine.length) return;
    sendMail_(u.Email, '[DCP] Send ' + mine.length + ' appointment reminder(s) for tomorrow (M4)',
      '<div style="font:13px Arial"><p>These patients have appointments on ' + tomorrow + '. Open the app → Reminders and click "Send on WhatsApp" for each.</p>' +
      digestRows_('Tomorrow\'s appointments', mine, [['Lead', 'id'], ['Clinic', 'clinic'], ['Lab', 'lab'], ['Slot', 'slot'], ['Mode', 'mode']]) + '</div>');
  });
}

/** Monday 8:00 AM IST — weekly management summary (BRD §9.5). */
function weeklySummary() {
  freshRun_();
  const today = todayIST_();
  const sys = systemCtx_();
  const w = dashSummary_(sys, { from: addDaysStr_(today, -6), to: today });
  const mtd = dashSummary_(sys, { from: today.slice(0, 8) + '01', to: today });
  const kpiRow = d => d.kpis.map(k => '<td style="padding:6px;border:1px solid #ddd"><b>' + escHtml_(k.label) + '</b><br>' +
    (k.value === null ? '—' : k.value + '%') + ' <span style="color:#888">(target ' + k.target + '%)</span><br><small>' + escHtml_(k.detail) + '</small></td>').join('');
  const funnelRow = d => d.funnel.map(f => '<td style="padding:6px;border:1px solid #ddd">' + escHtml_(f.stage) + '<br><b>' + f.count + '</b></td>').join('');
  const partnerRows = mtd.partners.map(p => '<tr><td>' + escHtml_(p.name) + '</td><td>' + p.leads + '</td><td>' + p.testDone + '</td><td>' + (p.conversion === null ? '—' : p.conversion + '%') +
    '</td><td>' + (p.medianReportTatH === null ? '—' : p.medianReportTatH + 'h') + '</td></tr>').join('');
  const html = '<div style="font:13px Arial">' +
    '<h2 style="font:600 16px Arial">DCP weekly summary · week ending ' + today + '</h2>' +
    '<p><b>Last 7 days:</b> ' + w.totals.leads + ' leads · ' + w.breachCount + ' SLA breaches open · earned ₹' + inr_(w.revenue.earnedInRange) + ' · collected ₹' + inr_(w.revenue.collectedInRange) + '</p>' +
    '<table style="border-collapse:collapse"><tr>' + kpiRow(w) + '</tr></table>' +
    '<p><b>Funnel (7 days):</b></p><table style="border-collapse:collapse"><tr>' + funnelRow(w) + '</tr></table>' +
    '<p><b>Month to date:</b> ' + mtd.totals.leads + ' leads · earned ₹' + inr_(mtd.revenue.earnedInRange) + ' · statements earned ₹' + inr_(mtd.revenue.statementEarned) +
    ' vs collected ₹' + inr_(mtd.revenue.statementCollected) + ' (outstanding ₹' + inr_(mtd.revenue.outstanding) + ')</p>' +
    '<table style="border-collapse:collapse"><tr>' + kpiRow(mtd) + '</tr></table>' +
    '<p><b>Partner turnaround (MTD)</b></p><table cellpadding="5" style="border-collapse:collapse;font:12px Arial"><tr><th>Partner</th><th>Leads</th><th>Test done</th><th>Conversion</th><th>Median report TAT</th></tr>' + partnerRows + '</table>' +
    '<p style="color:#666">Duplicates pending review: ' + mtd.pendingDuplicates + ' · Disputed leads: ' + mtd.disputed + '</p></div>';
  sendMail_(adminEmails_(), '[DCP] Weekly management summary · ' + today, html);
}

/** Sunday 2:00 AM IST — snapshot copy of the workbook, keep the latest N (BRD §10.6). */
function weeklyBackup() {
  freshRun_();
  const folder = rootFolder_('BACKUPS_FOLDER_ID', 'DCP Backups');
  const file = DriveApp.getFileById(DB.book().getId());
  file.makeCopy('DCP Backup ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm'), folder);
  const keep = cfgNum_('BACKUP_RETAIN_COUNT') || 12;
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (/^DCP Backup /.test(f.getName())) files.push(f); }
  files.sort((x, y) => y.getDateCreated() - x.getDateCreated());
  files.slice(keep).forEach(f => f.setTrashed(true));
  // DPDP retention scrub runs after the snapshot, so a pre-scrub copy always exists.
  // No-op unless an Admin has turned PII_RETENTION_ENABLED on.
  purgePii_();
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => { if (TRIGGER_FNS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(9).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('eveningReminders').timeBased().atHour(18).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone(TZ).create();
  return TRIGGER_FNS;
}

/* ----------------------------------------------------------------------------
 *  setup() — run ONCE from the Apps Script editor (bound to the DCP workbook)
 * --------------------------------------------------------------------------*/
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Run setup() from Extensions → Apps Script inside the DCP Google Sheet.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(TZ);
  DB.reset();
  const log = [];

  // 1. All 22 tabs present
  const missing = Object.keys(SH).map(k => SH[k]).filter(n => !ss.getSheetByName(n));
  if (missing.length) throw new Error('Missing tabs: ' + missing.join(', ') + '. Import DCP_App_Master_Seed_v1.xlsx as a Google Sheet first.');
  log.push('✓ All 22 tabs found');

  // 2. Two build columns appended to Leads (status timer + next scan date)
  const lsh = ss.getSheetByName(SH.LEADS);
  ['StatusChangedAt', 'NextScanDate'].forEach(col => {
    const hdr = lsh.getRange(1, 1, 1, lsh.getLastColumn()).getValues()[0].map(str_);
    if (hdr.indexOf(col) < 0) { lsh.getRange(1, hdr.length + 1).setValue(col); log.push('✓ Added Leads.' + col); }
  });

  // 3. New Config keys
  const csh = ss.getSheetByName(SH.CONFIG);
  const keys = csh.getRange(1, 1, csh.getLastRow(), 1).getValues().map(r => str_(r[0]));
  NEW_CONFIG_ROWS.forEach(r => {
    if (keys.indexOf(r[0]) < 0) { csh.appendRow([r[0], r[1], r[2], r[3], todayIST_(), 'setup()']); log.push('✓ Config ' + r[0] + ' = ' + r[1]); }
  });

  // 4. Plain-text format for IDs, phones, pincodes and dates (prevents Sheets auto-conversion)
  let fixed = 0;
  ss.getSheets().forEach(sh => {
    if (Object.keys(SH).map(k => SH[k]).indexOf(sh.getName()) < 0 || sh.getLastColumn() < 1) return;
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(str_);
    const rows = Math.max(sh.getMaxRows() - 1, 1);
    hdr.forEach((h, j) => {
      if (TEXT_COLS.indexOf(h) < 0) return;
      const rng = sh.getRange(2, j + 1, rows, 1);
      const vals = sh.getLastRow() > 1 ? sh.getRange(2, j + 1, sh.getLastRow() - 1, 1).getValues() : [];
      rng.setNumberFormat('@');
      if (vals.some(v => v[0] instanceof Date || (typeof v[0] === 'number' && PHONEISH[h]))) {
        sh.getRange(2, j + 1, vals.length, 1).setValues(vals.map(v => [normCell_(h, v[0])]));
        fixed++;
      }
    });
  });
  log.push('✓ Text format applied to ID / phone / pincode / date columns' + (fixed ? ' (' + fixed + ' columns normalised)' : ''));

  // 5. Remove seed example rows ("<-- EXAMPLE ROW: clear before use")
  const removedTransfers = [];
  [SH.REPORTS, SH.MESSAGES, SH.TRANSFERS].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh.getLastRow() < 2) return;
    const vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    for (let i = vals.length - 1; i >= 1; i--) {
      if (vals[i].some(c => /EXAMPLE ROW/i.test(String(c)))) {
        if (name === SH.TRANSFERS) removedTransfers.push(str_(vals[i][0]));
        sh.deleteRow(i + 1);
        log.push('✓ Removed example row from ' + name);
      }
    }
  });
  if (removedTransfers.length) {
    const ash = ss.getSheetByName(SH.ALLOCATIONS);
    if (ash.getLastRow() > 1) {
      const vals = ash.getRange(1, 1, ash.getLastRow(), ash.getLastColumn()).getValues();
      const iT = vals[0].map(str_).indexOf('TransferID');
      for (let i = vals.length - 1; i >= 1; i--) if (removedTransfers.indexOf(str_(vals[i][iT])) >= 0) { ash.deleteRow(i + 1); log.push('✓ Removed example allocation'); }
    }
  }

  // 6. Drive folders, webhook key, triggers
  DB.reset(); CFG_ = null;
  const rep = rootFolder_('REPORTS_FOLDER_ID', 'DCP Reports');
  const bak = rootFolder_('BACKUPS_FOLDER_ID', 'DCP Backups');
  log.push('✓ Drive folders: /DCP Reports (' + rep.getId() + '), /DCP Backups (' + bak.getId() + ')');
  if (!props.getProperty('MSG_WEBHOOK_KEY')) props.setProperty('MSG_WEBHOOK_KEY', randomHex_(16));
  installTriggers_();
  log.push('✓ Triggers: daily digest 09:00, evening reminders 18:00, Monday summary 08:00, Sunday backup 02:00 (IST)');

  // 7. Temporary password for the Admin owner
  const t = issueAdminTempPassword_();
  log.push(t);
  flushAudit_();
  const msg = log.join('\n');
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('DCP setup complete', msg + '\n\nNext: Deploy → New deployment → Web app (Execute as: Me · Who has access: Anyone).', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from editor */ }
  return msg;
}

function issueAdminTempPassword_() {
  DB.reset(); CFG_ = null;
  const ownerEmail = cfgStr_('ADMIN_OWNER_EMAIL').toLowerCase();
  const admin = DB.rows(SH.USERS).find(u => str_(u.Email).toLowerCase() === ownerEmail && str_(u.Role) === ROLE.ADMIN) ||
    DB.rows(SH.USERS).find(u => str_(u.Role) === ROLE.ADMIN && bool_(u.Active));
  if (!admin) return '✗ No Admin user found in Users — add one, then run "Issue Admin temporary password".';
  admin.Active = true;
  const r = issueTempPassword_(buildCtx_(admin), admin, 'setup()');
  return '✓ Admin ' + admin.Email + ' temporary password: ' + r.tempPassword + ' (expires ' + r.expires + ' IST' + (r.emailed ? ', also emailed' : '') + ')';
}

/* ---------- Sheet menu ---------- */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('DCP App')
      .addItem('1. Run setup (first time)', 'setup')
      .addItem('Re-install scheduled triggers', 'menuInstallTriggers')
      .addItem('Issue Admin temporary password', 'menuAdminPassword')
      .addItem('Show web app URL', 'menuShowUrl')
      .addToUi();
  } catch (e) { /* not in a UI context */ }
}
function menuInstallTriggers() { installTriggers_(); SpreadsheetApp.getUi().alert('Triggers installed: ' + TRIGGER_FNS.join(', ')); }
function menuAdminPassword() { const m = issueAdminTempPassword_(); flushAudit_(); SpreadsheetApp.getUi().alert(m); }
function menuShowUrl() { SpreadsheetApp.getUi().alert(appUrl_() || 'Not deployed yet: Deploy → New deployment → Web app.'); }
/* ============================================================================
 *  WEB APP ENTRY POINTS + API DISPATCHER
 *  Every call from Index.html goes through api(token, action, payload).
 *  Role permissions are checked here AND inside each function (defence in depth).
 * ==========================================================================*/

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Gynoveda DCP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function doPost(e) {
  let out = { ok: false, error: 'unknown endpoint' };
  try { if (e && e.parameter && e.parameter.hook === 'msg') out = handleMsgWebhook_(e); }
  catch (err) { out = { ok: false, error: err.message }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

const ALL_ROLES = [ROLE.ADMIN, ROLE.CM, ROLE.PC, ROLE.LAB];
const A = [ROLE.ADMIN];

const ACTIONS = {
  // auth
  'auth.login': { pub: true, write: true, fn: (c, p) => login_(p) },
  'auth.forgot': { pub: true, write: true, fn: (c, p) => forgotPassword_(p) },
  'auth.changePassword': { write: true, limitedOk: true, fn: changePassword_ },
  'auth.logout': { limitedOk: true, fn: logout_ },
  'boot': { fn: c => bootstrap_(c) },
  // leads
  'leads.queue': { roles: ALL_ROLES, fn: queue_ },
  'leads.search': { roles: ALL_ROLES, fn: search_ },
  'lead.get': { roles: ALL_ROLES, fn: leadDetail_ },
  'lead.dupcheck': { roles: [ROLE.CM, ROLE.ADMIN], fn: dupCheck_ },
  'lead.create': { roles: [ROLE.CM, ROLE.ADMIN], write: true, fn: createLead_ },
  'lead.transition': { roles: ALL_ROLES, write: true, fn: transition_ },
  'lead.progress': { roles: [ROLE.PC, ROLE.LAB, ROLE.ADMIN], write: true, fn: progress_ },
  'lead.addItem': { roles: [ROLE.CM, ROLE.PC, ROLE.ADMIN], write: true, fn: addItem_ },
  'lead.removeLine': { roles: [ROLE.CM, ROLE.PC, ROLE.ADMIN], write: true, fn: removeLine_ },
  'lead.overrideLine': { roles: A, write: true, fn: overrideLine_ },
  'lead.reschedule': { roles: [ROLE.PC, ROLE.ADMIN], write: true, fn: reschedule_ },
  'lead.payment': { roles: [ROLE.PC, ROLE.ADMIN], write: true, fn: recordPayment_ },
  'lead.edit': { roles: [ROLE.CM, ROLE.ADMIN], write: true, fn: editLead_ },
  'lead.reroute': { roles: A, write: true, fn: reroute_ },
  'lead.optout': { roles: [ROLE.CM, ROLE.PC, ROLE.ADMIN], write: true, fn: setOptOut_ },
  'lead.note': { roles: ALL_ROLES, write: true, fn: addNote_ },
  'lead.flagDispute': { roles: [ROLE.CM, ROLE.PC], write: true, fn: flagDispute_ },
  // reports & messages
  'report.upload': { roles: [ROLE.PC, ROLE.LAB, ROLE.ADMIN], write: true, fn: uploadReport_ },
  'report.get': { roles: ALL_ROLES, fn: getReport_ },
  'msg.log': { roles: ALL_ROLES, write: true, fn: logMessage_ },
  'msg.rating': { roles: [ROLE.CM, ROLE.PC, ROLE.ADMIN], write: true, fn: recordRating_ },
  'reminders': { roles: [ROLE.CM, ROLE.PC, ROLE.ADMIN], fn: reminders_ },
  // settlement
  'stmt.list': { roles: [ROLE.PC, ROLE.ADMIN], fn: listStatements_ },
  'stmt.lines': { roles: [ROLE.PC, ROLE.ADMIN], fn: statementLines_ },
  'stmt.generate': { roles: A, write: true, fn: generateStatement_ },
  'stmt.confirm': { roles: [ROLE.PC, ROLE.ADMIN], write: true, fn: confirmStatement_ },
  'stmt.flagLine': { roles: [ROLE.PC, ROLE.ADMIN], write: true, fn: flagLine_ },
  'stmt.resolveLine': { roles: A, write: true, fn: resolveLine_ },
  'stmt.allocate': { roles: A, write: true, fn: (c, p) => allocateCredit_(c, str_(p.partnerId)) },
  'stmt.closeEligible': { roles: A, write: true, fn: closeEligible_ },
  'transfer.record': { roles: A, write: true, fn: recordTransfer_ },
  // admin
  'dash.summary': { roles: A, fn: dashSummary_ },
  'users.list': { roles: A, fn: listUsers_ },
  'users.save': { roles: A, write: true, fn: saveUser_ },
  'users.setActive': { roles: A, write: true, fn: setUserActive_ },
  'users.sendTemp': { roles: A, write: true, fn: sendTemp_ },
  'users.unlock': { roles: A, write: true, fn: unlockUser_ },
  'md.list': { roles: A, fn: mdList_ },
  'md.save': { roles: A, write: true, fn: mdSave_ },
  'partner.validate': { roles: A, fn: partnerValidation_ },
  'partner.activate': { roles: A, write: true, fn: partnerActivate_ },
  'partner.setState': { roles: A, write: true, fn: partnerSetState_ },
  'labs.activate': { roles: A, write: true, fn: labsActivate_ },
  'lab.setState': { roles: A, write: true, fn: labSetState_ },
  'lab.request': { roles: [ROLE.PC], write: true, fn: requestLab_ },
  'rc.newVersion': { roles: A, write: true, fn: rcNewVersion_ },
  'rc.activateVersion': { roles: A, write: true, fn: rcActivateVersion_ },
  'rc.activateItems': { roles: A, write: true, fn: rcActivateItems_ },
  'dup.list': { roles: A, fn: dupList_ },
  'dup.resolve': { roles: A, write: true, fn: dupResolve_ },
  'dispute.list': { roles: A, fn: disputeList_ },
  'dispute.dismiss': { roles: A, write: true, fn: disputeDismiss_ },
  'audit.list': { roles: A, fn: auditList_ },
  'config.view': { roles: A, fn: configView_ },
  'privacy.erasePatient': { roles: A, write: true, fn: erasePatient_ },
  'config.msgApi': { roles: A, write: true, fn: setMsgApi_ },
  'export.table': { roles: A, write: true, fn: exportTable_ },
  'footfall.recompute': { roles: A, write: true, fn: footfallRecompute_ }
};

/**
 * Single entry point for the client. Returns a JSON string so values survive
 * google.script.run serialisation unchanged.
 */
function api(token, action, payload) {
  let lock = null;
  const t0 = Date.now();
  // Each google.script.run call is a fresh execution in Apps Script; reset explicitly anyway.
  DB.reset(); resetGroups_(); CFG_ = null; LOCK_HELD_ = false;
  Object.keys(SEQ_).forEach(k => { delete SEQ_[k]; });
  AUDIT_BUF_.length = 0;
  try {
    const def = ACTIONS[action];
    if (!def) fail_('Unknown action: ' + action);
    if (def.write) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) { lock = null; fail_('The system is busy. Please try again in a few seconds.'); }
      LOCK_HELD_ = true;
      DB.reset(); resetGroups_(); CFG_ = null;
    }
    let ctx = null;
    if (!def.pub) {
      ctx = authCtx_(token, !!def.limitedOk);
      if (def.roles && def.roles.indexOf(ctx.role) < 0) fail_('This action is not permitted for your role (' + ctx.role + ').');
    }
    const data = def.fn(ctx, payload || {});
    return JSON.stringify({ ok: true, data: data, ms: Date.now() - t0 });
  } catch (e) {
    const userFacing = e && e.userFacing;
    if (!userFacing) console.error('api ' + action + ' failed: ' + (e && e.stack ? e.stack : e));
    return JSON.stringify({ ok: false, error: userFacing ? e.message : 'Something went wrong (' + (e && e.message ? e.message : e) + '). Please try again; if it repeats, tell the DCP Admin.', code: e && e.code ? e.code : '' });
  } finally {
    try { flushAudit_(); } catch (e2) { console.error('audit flush failed: ' + e2.message); }
    if (lock) { LOCK_HELD_ = false; lock.releaseLock(); }
  }
}

/** Everything the client needs after sign-in, filtered to the user's role and scope. */
function bootstrap_(ctx) {
  const isAdmin = ctx.role === ROLE.ADMIN;
  const clinics = DB.rows(SH.CLINICS).filter(c => isAdmin || (ctx.role !== ROLE.LAB && inClinicScope_(ctx, c.ClinicID))).map(c => {
    const route = routeForClinic_(c);
    const status = str_(c.Status);
    return {
      id: str_(c.ClinicID), name: str_(c.Name), city: str_(c.City), areaId: str_(c.AreaID), regionId: str_(c.RegionID), status: status,
      partnerId: str_(c.DefaultPartnerID), partner: partnerName_(c.DefaultPartnerID),
      doctors: splitList_(c.ReferringDoctors, '|'), canCapture: status === 'Active' && !route.error,
      captureBlock: status !== 'Active' ? c.Name + ' is ' + (status || 'not active') + ' — new leads are blocked.' : (route.error || '')
    };
  });
  const catalogues = {};
  if (ctx.role === ROLE.CM || isAdmin) {
    uniq_(clinics.filter(c => c.canCapture).map(c => c.partnerId)).forEach(pid => { catalogues[pid] = catalogue_(pid, true, ctx); });
  }
  const out = {
    user: { id: ctx.userId, name: ctx.name, email: ctx.email, role: ctx.role, orgId: ctx.orgId, scopeType: ctx.scopeType,
      scopeIds: ctx.scopeIds, partnerId: ctx.partnerId, labIds: ctx.labIds, clinicIds: ctx.clinicIds,
      orgName: ctx.role === ROLE.PC ? partnerName_(ctx.partnerId) : ctx.role === ROLE.LAB ? labName_(ctx.labIds[0]) : ctx.role === ROLE.CM ? clinicName_(ctx.orgId) : 'Gynoveda HQ' },
    cfg: {
      APP_VERSION: APP_VERSION, AUTO_REFRESH_SECONDS: cfgNum_('AUTO_REFRESH_SECONDS'), MAX_REPORT_PDF_MB: cfgNum_('MAX_REPORT_PDF_MB'),
      MSG_MODE: cfgStr_('MSG_MODE'), DUPLICATE_WINDOW_DAYS: cfgNum_('DUPLICATE_WINDOW_DAYS'),
      PACKAGE_INDIVIDUAL_RULE: cfgStr_('PACKAGE_INDIVIDUAL_RULE'), SPOUSE_AGE_MIN: cfgNum_('SPOUSE_AGE_MIN'), SPOUSE_AGE_MAX: cfgNum_('SPOUSE_AGE_MAX'),
      PASSWORD_MIN_LENGTH: cfgNum_('PASSWORD_MIN_LENGTH'), STATEMENT_DISPUTE_WINDOW_DAYS: cfgNum_('STATEMENT_DISPUTE_WINDOW_DAYS')
    },
    consts: { ST: ST, REASONS: REASONS, ROLE: ROLE, TRANSFER_MODES: TRANSFER_MODES, FOLLOWUP_ST: FOLLOWUP_ST, TERMINAL_ST: TERMINAL_ST },
    clinics: clinics, catalogues: catalogues, today: todayIST_(),
    // Region/Area names: sent to every role (not just Admin) so the Queue/Search region & area filters (BRD §9.1) show names, not raw IDs.
    regions: DB.rows(SH.REGIONS).map(r => ({ id: str_(r.RegionID), name: str_(r.Name), active: bool_(r.Active) })),
    areas: DB.rows(SH.AREAS).map(a => ({ id: str_(a.AreaID), regionId: str_(a.RegionID), name: str_(a.Name), active: bool_(a.Active) }))
  };
  if (isAdmin) {
    out.partners = DB.rows(SH.PARTNERS).map(p => ({ id: str_(p.PartnerID), name: str_(p.DisplayName), state: str_(p.State), type: str_(p.Type) }));
    out.labs = DB.rows(SH.LABS).map(l => ({ id: str_(l.LabID), name: str_(l.LabName), partnerId: str_(l.PartnerID), clinicId: str_(l.ClinicIDServed), state: str_(l.State) }));
    out.mdTables = Object.keys(MD_TABLES);
  }
  if (ctx.role === ROLE.PC) {
    out.partners = [{ id: ctx.partnerId, name: partnerName_(ctx.partnerId), state: str_((partner_(ctx.partnerId) || {}).State) }];
    out.labs = DB.rows(SH.LABS).filter(l => str_(l.PartnerID) === ctx.partnerId)
      .map(l => ({ id: str_(l.LabID), name: str_(l.LabName), partnerId: str_(l.PartnerID), clinicId: str_(l.ClinicIDServed), state: str_(l.State) }));
  }
  if (ctx.role === ROLE.LAB) {
    const lb = lab_(ctx.labIds[0]) || {};
    out.lab = { id: str_(lb.LabID), name: str_(lb.LabName), address: str_(lb.Address), partner: partnerName_(lb.PartnerID) };
  }
  return out;
}
