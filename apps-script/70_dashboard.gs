/* ============================================================================
 *  DASHBOARD & KPIs (BRD §1.3, §9.1)
 * ==========================================================================*/

/**
 * dashMonthly_  — Month-over-month comparison table (screenshot format).
 * Returns an array of { month, label } objects with metrics for each month.
 * Called by dash.monthly API.
 */
function dashMonthly_(ctx, p) {
  p = p || {};
  const today = fmtD_(new Date());
  // Up to 6 months back; default shows current + previous
  const numMonths = Math.min(Math.max(Number(p.months) || 2, 1), 6);
  const geo = geoFilter_(p);
  const allLeads = DB.rows(SH.LEADS).filter(geo);

  // Determine which months to include (most-recent first → reverse for display)
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const monthList = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    let y = ty, m = tm - i;
    while (m < 1) { m += 12; y -= 1; }
    const ym = y + '-' + String(m).padStart(2, '0');
    const label = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + '-' + String(y).slice(2);
    monthList.push({ ym, label });
  }

  const monthStats = monthList.map(({ ym, label }) => {
    const leads = allLeads.filter(l => str_(l.CreatedAt).slice(0, 7) === ym);

    // Live clinics: distinct clinics with at least 1 lead this month
    const liveClinics = uniq_(leads.map(l => str_(l.ClinicID))).filter(Boolean).length;

    // Tests: sum of active test items across leads that reached test-done this month
    const testDoneLeads = leads.filter(l => stageRank_(l) >= 4);
    let totalTests = 0, maleTests = 0, femaleTests = 0;
    testDoneLeads.forEach(l => {
      const lines = leadLines_(str_(l.LeadID));
      const itemCount = lines.filter(ln => bool_(ln.Active)).length || 1;
      totalTests += itemCount;
      if (str_(l.Gender).toUpperCase() === 'M') maleTests += itemCount;
      else femaleTests += itemCount;
    });

    // Adoption = share of this month's leads that got booked (BRD redefinition, per Admin):
    // same lead population as the conversion/test-done count below, just the earlier funnel
    // checkpoint. No longer tied to ClinicFootfall — nothing to fill in for this to show a value.
    const bookedLeads = leads.filter(l => stageRank_(l) >= 2);
    const adoption = leads.length ? pct_(bookedLeads.length, leads.length) : null;

    // Margin: sum ExpectedMarginRs for test-done leads; Revenue in Lakhs
    const marginRs = testDoneLeads.reduce((a, l) => a + num_(l.ExpectedMarginRs), 0);
    const marginTotal = leads.reduce((a, l) => a + num_(l.ExpectedMarginRs), 0);
    const patientTotal = leads.reduce((a, l) => a + num_(l.ExpectedPatientPrice), 0);
    // Gyno margin % = margin / patient revenue
    const gynoMarginPct = patientTotal > 0 ? Math.round(marginTotal / patientTotal * 1000) / 10 : null;
    // Gyno Revenue in Lakhs (margin earned)
    const gynoRevLakhs = Math.round(marginRs / 1000) / 100; // Rs → Lakhs (1L = 100000)

    const testPerPatient = testDoneLeads.length > 0 ? Math.round(totalTests / testDoneLeads.length * 100) / 100 : null;

    return {
      month: ym, label,
      liveClinics,
      leads: leads.length,
      adoption,
      noOfTests: totalTests,
      testPerPatient,
      maleTest: maleTests,
      femaleTest: femaleTests,
      gynoMarginPct,
      gynoRevLakhs
    };
  });

  return { months: monthStats, geo: { partnerId: p.partnerId || '', clinicId: p.clinicId || '' } };
}

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

  // Which clinic visit the patient took up the test on (V1, V2, V3…). Leads captured before this
  // field existed, or with it left blank, fall into "Unspecified" rather than being dropped.
  const byVisit = (() => {
    const g = {};
    cohort.forEach(l => {
      const v = Number(l.VisitNumber);
      const k = Number.isInteger(v) && v >= 1 ? v : 0; // 0 = Unspecified
      (g[k] = g[k] || []).push(l);
    });
    return Object.keys(g).map(Number).sort((a, b) => a - b).map(v => {
      const ls = g[v], d = ls.filter(l => stageRank_(l) >= 4);
      return { visit: v === 0 ? 'Unspecified' : 'V' + v, leads: ls.length, testDone: d.length, conversion: pct_(d.length, ls.length) };
    });
  })();

  // KPI 1: Adoption = leads that reached "Test booked" or beyond (BRD redefinition, per Admin:
  // the earlier funnel checkpoint — did the clinic's lead actually get booked).
  const booked = cohort.filter(l => stageRank_(l) >= 2);
  // KPI 2: Conversion = leads that reached "Test done" or beyond — the later funnel checkpoint,
  // same lead population and window as Adoption above, just further downstream. The gap between
  // the two (booked but never done) is where follow-through is breaking, not referral.
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
    { key: 'adoption', label: 'Adoption % · last 30 days', what: 'Of DCP leads, share that got BOOKED (early funnel)',
      value: pct_(booked.length, cohort.length), target: cfgNum_('KPI_TARGET_ADOPTION_PCT'), detail: booked.length + ' of ' + cohort.length + ' leads booked, rolling 30 days' },
    { key: 'conversion', label: 'Conversion % · last 30 days', what: 'Of DCP leads, share that completed the TEST (late funnel)',
      value: pct_(done.length, cohort.length), target: cfgNum_('KPI_TARGET_CONVERSION_PCT'), detail: done.length + ' of ' + cohort.length + ' leads completed, rolling 30 days' },
    { key: 'ontime', label: 'Report on time %', what: 'Share of due reports delivered within TAT',
      value: pct_(onTime, rtDen), target: cfgNum_('KPI_TARGET_REPORT_ONTIME_PCT'), detail: onTime + ' of ' + rtDen + ' due reports within TAT' },
    { key: 'collection', label: 'Commission collected %', what: 'Share of earned margin actually collected',
      value: pct_(stCollected, stEarned), target: cfgNum_('KPI_TARGET_COLLECTION_PCT'), detail: '₹' + inr_(stCollected) + ' of ₹' + inr_(stEarned) + ' on statements' },
    { key: 'csat', label: 'Patient satisfaction %', what: 'Share of M9 replies rating 4 or 5',
      value: ratings.length ? pct_(ratings.filter(r => r >= 4).length, ratings.length) : null, target: cfgNum_('KPI_TARGET_CSAT_PCT'), detail: ratings.length ? ratings.length + ' M9 replies' : 'No M9 replies recorded yet' }
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
      const ls = g[k], b = ls.filter(l => stageRank_(l) >= 2), d = ls.filter(l => stageRank_(l) >= 4);
      const rt = ls.filter(l => str_(l.ReportGeneratedAt) && str_(l.TestDoneAt)).map(l => (parseDT_(l.ReportGeneratedAt) - parseDT_(l.TestDoneAt)) / 3600000);
      const reasons = {};
      ls.filter(l => [ST.CANCEL, ST.NI].indexOf(str_(l.Status)) >= 0).forEach(l => { const r = str_(l.CancelReason).split(' of ')[0].split(':')[0] || 'Unspecified'; reasons[r] = (reasons[r] || 0) + 1; });
      const ids = {}; ls.forEach(l => { ids[l.LeadID] = 1; });
      const rr = DB.rows(SH.MESSAGES).filter(m => str_(m.TemplateCode) === 'M9-REPLY' && ids[str_(m.LeadID)]).map(m => Number(str_(m.Status).replace('rating:', ''))).filter(n => n >= 1);
      return {
        id: k, name: nameFn(k), leads: ls.length, testDone: d.length, adoption: pct_(b.length, ls.length), conversion: pct_(d.length, ls.length),
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
    // c.adoption already set by card() above (booked ÷ leads for this clinic) — no footfall lookup needed.
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
    kpis: kpis, funnel: funnel, statusCounts: statusCounts, byVisit: byVisit,
    revenue: { byState: byRev, earnedInRange: earnedInRange, collectedInRange: collectedInRange, statementEarned: stEarned, statementCollected: stCollected, outstanding: round2_(stEarned - stCollected), months: months },
    breaches: breaches.slice(0, 150), breachCount: breaches.length, breachByStage: breachByStage,
    partners: partners, labs: labs.slice(0, 40), clinics: clinics, byState: byState, byCity: byCity, weeks: weeks,
    medianReportTatH: tats.length ? Math.round(median_(tats) * 10) / 10 : null,
    pendingDuplicates: DB.rows(SH.DUPES).filter(d => /Pending/.test(str_(d.ResolutionStatus))).length,
    disputed: DB.rows(SH.LEADS).filter(l => str_(l.Status) === ST.DISPUTED).length
  };
}
