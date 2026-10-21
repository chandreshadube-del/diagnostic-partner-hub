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
  Packages: 'PackageCode', RateCards: 'RateCardID', Templates: 'TemplateCode', Config: 'Key'
  // ClinicFootfall dropped (v3.0.10): footfall can't be captured, so there was nothing to put in that editor.
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
  // Deep link straight to the Audit tab in the live Sheet, so an Admin can jump from the
  // in-app log to the raw rows (e.g. to copy/filter/pivot) without hunting for the tab by hand.
  let sheetUrl = '';
  try { sheetUrl = DB.book().getUrl() + '#gid=' + DB.sheet(SH.AUDIT).getSheetId(); } catch (e) { /* not fatal */ }
  return { rows: rows, sheetUrl: sheetUrl };
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

/* footfallRecompute_ removed (v3.0.10): Adoption/Conversion no longer use ClinicFootfall —
 * both are computed straight from Leads (booked÷leads, done÷leads). Footfall can't be
 * reliably captured, so there's nothing for this to recompute against anymore. */

/* ----------------------------------------------------------------------------
 *  DPDP retention & erasure
 *  Patient PII is scrubbed from closed leads once they pass the retention
 *  window, and on demand when a patient exercises their right to erasure.
 *  Business/analytics fields (dates, status, clinic, partner, amounts, age,
 *  gender, pincode) are deliberately kept — they carry no direct identifier
 *  and the KPI and commission reports depend on them.
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
