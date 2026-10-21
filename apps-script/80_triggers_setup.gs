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

  // 2. Build columns appended to Leads (status timer + next scan date + prescription-pad photo ref + visit number)
  const lsh = ss.getSheetByName(SH.LEADS);
  ['StatusChangedAt', 'NextScanDate', 'RxFileID', 'RxFileName', 'RxUploadedAt', 'VisitNumber'].forEach(col => {
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

  // 7. Temporary password for the Admin owner — first run only. setup() is also what an upgrade re-runs to pick up
  // new Leads columns / Config rows (the "run setup() again" messages), so it must never replace a live Admin password.
  log.push(adminPasswordIssued_()
    ? '✓ Admin password left unchanged — setup() already issued one. To reset it: DCP App ▸ Issue Admin temporary password.'
    : issueAdminTempPassword_());
  flushAudit_();
  const msg = log.join('\n');
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('DCP setup complete', msg + '\n\nNext: Deploy → New deployment → Web app (Execute as: Me · Who has access: Anyone).', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from editor */ }
  return msg;
}

/** True once setup() (or the menu reset) has issued the Admin owner a temporary password — recorded in the Audit tab. */
function adminPasswordIssued_() {
  return readAudit_(o => str_(o.Action) === 'TEMP_PASSWORD_ISSUED' && /^setup\(\)/.test(str_(o.Note)), 1).length > 0;
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
