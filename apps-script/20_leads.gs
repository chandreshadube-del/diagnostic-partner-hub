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
  o.VisitNumber = Number(p.visitNumber);
  need_(Number.isInteger(o.VisitNumber) && o.VisitNumber >= 1 && o.VisitNumber <= 20,
    'Select which clinic visit this is for the patient (V1, V2, V3…).');
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
      warnings.push('"' + meta.name + '" priced at ₹' + inr_(header.FrozenPatientPrice) + ' — ' + Math.round(prorate * 100) +
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
    ReferringDoctor: pat.ReferringDoctor, Urgency: pat.Urgency, PreferredMode: pat.PreferredMode, BookingMode: '', VisitNumber: pat.VisitNumber,
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

  // Prescription-pad photo (optional, BRD §3): never blocks lead capture — a bad or oversized
  // photo, or a workbook that hasn't had setup() re-run yet, becomes a warning, not a failure.
  if (str_(p.rxB64)) {
    if (!DB.hasColumn(SH.LEADS, 'RxFileID')) {
      warnings.push('Prescription photo was NOT saved — run setup() again from Extensions → Apps Script to enable this, then upload it from the lead detail page.');
    } else {
      try { applyPrescriptionUpload_(ctx, lead, p.rxB64, ''); }
      catch (e) { warnings.push('Prescription photo was not saved: ' + (e.userFacing ? e.message : 'upload failed — try again from the lead detail page.')); }
    }
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
