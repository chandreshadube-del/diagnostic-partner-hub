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
