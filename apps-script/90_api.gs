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
  'lead.uploadPrescription': { roles: [ROLE.CM, ROLE.ADMIN], write: true, fn: uploadPrescription_ },
  'lead.getPrescription': { roles: ALL_ROLES, fn: getPrescription_ },
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
  // Cached ~45s, shared across every admin viewing the dashboard concurrently (CacheService is
  // script-wide, not per-user) — the heaviest read in the app (scans Leads, LeadTests, Messages,
  // Statements, StatementLines, Allocations in full) otherwise reruns from scratch on every open/
  // filter-change, by every admin, even when nothing changed. Any write anywhere bumps the epoch
  // and invalidates it immediately, so a fresh action is never masked by a stale dashboard.
  'dash.summary': { roles: A, fn: (ctx, p) => cached_('dash.summary:' + dashEpoch_() + ':' + JSON.stringify(p), 45, () => dashSummary_(ctx, p)) },
  'dash.monthly': { roles: A, fn: (ctx, p) => cached_('dash.monthly:' + dashEpoch_() + ':' + JSON.stringify(p), 45, () => dashMonthly_(ctx, p)) },
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
  'export.table': { roles: A, write: true, fn: exportTable_ }
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
    if (def.write) bumpDashEpoch_(); // invalidate cached dashboard reads — next one recomputes fresh
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
      MAX_PRESCRIPTION_MB: cfgNum_('MAX_PRESCRIPTION_MB'), RX_ENABLED: DB.hasColumn(SH.LEADS, 'RxFileID'),
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
