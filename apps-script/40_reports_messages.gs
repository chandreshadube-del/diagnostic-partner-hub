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

/* ---------- prescription-pad photo (BRD §3) ----------
 * One photo per lead, taken at booking time or added/replaced later from the lead detail
 * page. Stored on the Lead row itself (RxFileID/RxFileName/RxUploadedAt) rather than a
 * separate sheet, so an existing workbook needs only setup() re-run (adds the columns) —
 * never a new tab. If those columns aren't there yet, uploads are skipped with a clear
 * message instead of silently creating an orphaned Drive file nothing can find again.
 */

/**
 * Validates + uploads a prescription-pad photo and mutates `lead` in place
 * (RxFileID/RxFileName/RxUploadedAt). Does NOT write to the sheet — the caller does
 * DB.insert (new lead) or DB.update (replace on an existing lead). Throws a user-facing
 * error on bad input; callers that must not block on a bad photo should catch it.
 */
function applyPrescriptionUpload_(ctx, lead, b64, note) {
  need_(str_(b64).length > 0, 'Choose a photo of the prescription pad.');
  const bytes = Utilities.base64Decode(str_(b64));
  need_(bytes.length >= 64, 'The photo looks empty or damaged — retake it and try again.');
  const sizeMB = bytes.length / 1048576;
  const max = cfgNum_('MAX_PRESCRIPTION_MB');
  need_(sizeMB <= max, 'The photo is ' + sizeMB.toFixed(1) + ' MB — the limit is ' + max + ' MB.');
  // Utilities.base64Decode() returns SIGNED bytes (-128..127), so magic-byte checks must
  // mask to unsigned (& 0xFF) before comparing — a plain === against 0xFF/0x89/etc. never matches.
  const u8 = i => bytes[i] & 0xFF;
  let mime = '', ext = '';
  if (bytes.length > 3 && u8(0) === 0xFF && u8(1) === 0xD8 && u8(2) === 0xFF) { mime = 'image/jpeg'; ext = 'jpg'; }
  else if (bytes.length > 8 && u8(0) === 0x89 && u8(1) === 0x50 && u8(2) === 0x4E && u8(3) === 0x47) { mime = 'image/png'; ext = 'png'; }
  else fail_('Only JPG or PNG photos can be uploaded.');

  // One photo per lead: trash the previous file (if any) so Drive doesn't accumulate retakes.
  if (str_(lead.RxFileID)) { try { DriveApp.getFileById(lead.RxFileID).setTrashed(true); } catch (e) { /* already gone — not fatal */ } }

  const ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const folder = subFolder_(subFolder_(rootFolder_('PRESCRIPTIONS_FOLDER_ID', 'DCP Prescriptions'), str_(lead.ClinicID)), ym);
  const fileName = lead.LeadID + '.' + ext; // patient names never appear in file names (same rule as Reports, BRD §7.3)
  const file = folder.createFile(Utilities.newBlob(bytes, mime, fileName));
  lead.RxFileID = file.getId();
  lead.RxFileName = fileName;
  lead.RxUploadedAt = nowIST_();
  return { fileId: lead.RxFileID, fileName: fileName, sizeMB: round2_(sizeMB) };
}

/** Upload/replace the prescription photo on an existing lead (CM or Admin only). */
function uploadPrescription_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_([ROLE.CM, ROLE.ADMIN].indexOf(ctx.role) >= 0, 'Your role can\'t upload prescriptions.');
  need_(DB.hasColumn(SH.LEADS, 'RxFileID'), 'Prescription uploads aren\'t enabled on this workbook yet — run setup() again from Extensions → Apps Script to add the required columns.');
  const before = { RxFileName: str_(lead.RxFileName) };
  const res = applyPrescriptionUpload_(ctx, lead, p.b64, p.note);
  DB.update(SH.LEADS, lead);
  audit_(ctx, 'PRESCRIPTION_UPLOADED', lead.LeadID, 'Lead', lead.LeadID, before, { RxFileName: res.fileName, sizeMB: res.sizeMB }, str_(p.note).slice(0, 300));
  return { fileName: res.fileName };
}

/** Streams the prescription photo after a role + scope check; every view is audited. */
function getPrescription_(ctx, p) {
  const lead = mustLead_(p.leadId);
  assertSee_(ctx, lead);
  need_(str_(lead.RxFileID), 'No prescription photo uploaded for this lead yet.');
  let blob;
  try { blob = DriveApp.getFileById(str_(lead.RxFileID)).getBlob(); }
  catch (e) { fail_('The prescription photo could not be opened from Drive (it may have been moved or deleted).'); }
  audit_(ctx, 'PRESCRIPTION_VIEWED', lead.LeadID, 'Lead', lead.LeadID, null, null, p.download ? 'download' : 'view');
  return { fileName: str_(lead.RxFileName), mime: blob.getContentType() || 'image/jpeg', b64: Utilities.base64Encode(blob.getBytes()) };
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
