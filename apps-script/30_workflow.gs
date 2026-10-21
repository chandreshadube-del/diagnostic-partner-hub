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
    prescription: str_(lead.RxFileID) ? { fileName: str_(lead.RxFileName), uploadedAt: str_(lead.RxUploadedAt) } : null,
    canUploadPrescription: [ROLE.CM, ROLE.ADMIN].indexOf(ctx.role) >= 0 && DB.hasColumn(SH.LEADS, 'RxFileID'),
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
