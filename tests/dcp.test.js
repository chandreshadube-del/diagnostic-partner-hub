/* End-to-end checks of the DCP server, driven through the same api() dispatcher the web app uses.
 * Run: npm test   (Node >= 20, no dependencies)
 * The sources under apps-script/ are loaded unmodified; only the Google services are mocked.
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, pdfB64 } = require('./harness');
const { PASSWORD } = require('./fixtures/workbook');

const A = createApp();
const TODAY = '2026-10-21', TOMORROW = '2026-10-22';
const ok = (r, what) => assert.ok(r.ok, (what || 'expected success') + ' — server said: ' + r.error);
const fails = (r, re, what) => { assert.equal(r.ok, false, (what || 'expected a refusal') + ' but it succeeded'); if (re) assert.match(r.error, re); return r; };
const tok = {};                                     // role -> session token
const L = {};                                       // named leads -> LeadID
const signIn = () => {
  tok.admin = A.login('owner@example.test'); tok.cmA = A.login('cm.a@example.test'); tok.cmB = A.login('cm.b@example.test');
  tok.pcA = A.login('pc.aa@example.test'); tok.pcB = A.login('pc.bb@example.test'); tok.labA = A.login('lab.aa@example.test');
};
let phoneSeq = 11;
const mkLead = (o) => Object.assign({ clinicId: 'CL-AAA', patientName: 'Test Patient', gender: 'F', age: 30, phone: '90000000' + String(phoneSeq++),
  pincode: '400001', bookingType: 'Individual', referringDoctor: 'Dr. Asha', urgency: 'Normal', preferredMode: 'Lab visit', notesForLab: '',
  visitNumber: 1, consent: true, items: [{ code: 'TST-001', tag: 'P' }, { code: 'TST-002', tag: 'P' }] }, o || {});
const create = (o, token) => A.call(token || tok.cmA, 'lead.create', mkLead(o));
const detail = (id, token) => { const r = A.call(token || tok.admin, 'lead.get', { leadId: id }); ok(r, 'lead.get ' + id); return r.data; };
const status = id => detail(id).lead.Status;
const go = (token, id, to, extra) => A.call(token, 'lead.transition', Object.assign({ leadId: id, to: to }, extra || {}));
const lineIds = id => detail(id).lines.filter(l => l.Active && !l.isHeader).map(l => l.LeadTestID);

/** Drive a lead from capture to Test done (and optionally report) with the standard happy path. */
function advance(id, upTo) {
  ok(go(tok.pcA, id, 'Called by lab', { note: 'Spoke to patient' }), 'called');
  ok(go(tok.pcA, id, 'Test booked'), 'booked');
  ok(go(tok.pcA, id, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '10:30' }), 'scheduled');
  if (upTo === 'scheduled') return;
  ok(A.call(tok.labA, 'lead.progress', { leadId: id, updates: lineIds(id).map(x => ({ leadTestId: x })) }), 'progress');
  ok(go(tok.labA, id, 'Test done'), 'test done');
  if (upTo === 'done') return;
  ok(A.call(tok.pcA, 'lead.payment', { leadId: id, paymentAmount: 1200, paymentMode: 'UPI', paymentDate: TODAY, paymentRef: 'R-' + id }), 'payment');
  ok(A.call(tok.labA, 'report.upload', { leadId: id, personTag: 'P', fileName: 'r.pdf', b64: pdfB64(), markGenerated: true }), 'report');
}

describe('0 · load', () => {
  it('loads all ten modules and registers 65 actions', () => {
    assert.equal(A.files.length, 10);
    assert.equal(A.ev('APP_VERSION'), '3.0.13');
    assert.equal(A.ev('Object.keys(ACTIONS).length'), 65);
  });
  it('doGet serves the Index page', () => {
    const out = A.fn('doGet', [{}]);
    assert.equal(out.title, 'Gynoveda DCP');
    assert.match(out.content, /<title>Gynoveda DCP<\/title>/);
  });
});

describe('1 · setup() on a workbook shaped like the live sheet', () => {
  let log, temp;
  it('starts with 53 Leads columns and no Rx/Visit columns', () => {
    const n = A.ev('DB.headers("Leads").filter(Boolean).length');
    assert.equal(n, 53);
    assert.equal(A.ev('DB.hasColumn("Leads", "VisitNumber")'), false);
  });
  it('adds the four v3.0.13 Leads columns and the new Config rows, installs 4 triggers', () => {
    log = A.fn('setup');
    for (const c of ['RxFileID', 'RxFileName', 'RxUploadedAt', 'VisitNumber']) assert.match(log, new RegExp('Added Leads\\.' + c));
    assert.equal(A.ev('DB.headers("Leads").filter(Boolean).length'), 57);
    assert.match(log, /Config MAX_PRESCRIPTION_MB = 8/);
    assert.equal(A.ev('__gas.triggers.length'), 4);
    assert.match(log, /Drive folders/);
    temp = (log.match(/temporary password: (\S+)/) || [])[1];
    assert.ok(temp, 'setup() should report the Admin temporary password');
  });
  it('normalises numeric phone/date cells to text', () => {
    assert.equal(typeof A.rows('Partners')[0].PrimaryContactMobile, 'string');
  });
  it('first sign-in with the temporary password forces a password change', () => {
    const r = A.call('', 'auth.login', { email: 'owner@example.test', password: temp });
    ok(r, 'temp login'); assert.equal(r.data.mustChangePassword, true);
    const blocked = A.call(r.data.token, 'boot', {});
    fails(blocked, /set a new password/); assert.equal(blocked.code, 'PASSWORD_CHANGE_REQUIRED');
    const c = A.call(r.data.token, 'auth.changePassword', { newPassword: PASSWORD, confirmPassword: PASSWORD });
    ok(c, 'change password'); assert.equal(c.data.boot.user.role, 'Admin');
  });
  it('re-running setup() — which the app itself tells users to do — must not reset the Admin password', () => {
    const before = A.rows('Users').find(u => u.UserID === 'USR-ADM-01').PasswordHash;
    const again = A.fn('setup');
    const after = A.rows('Users').find(u => u.UserID === 'USR-ADM-01');
    assert.equal(after.PasswordHash, before, 'Admin password hash was replaced by a re-run of setup()');
    assert.equal(String(after.ForcePasswordChange).toUpperCase(), 'FALSE');
    assert.doesNotMatch(again, /temporary password: \S+/, 'no new password may be issued');
    assert.match(again, /Admin password left unchanged/);
    ok(A.call('', 'auth.login', { email: 'owner@example.test', password: PASSWORD }), 'admin can still sign in with their own password');
  });
  it('setup() is otherwise idempotent (no duplicate columns, rows or triggers)', () => {
    assert.equal(A.ev('DB.headers("Leads").filter(Boolean).length'), 57);
    assert.equal(A.ev('DB.rows("Config").filter(r => r.Key === "MAX_PRESCRIPTION_MB").length'), 1);
    assert.equal(A.ev('__gas.triggers.length'), 4);
  });
});

describe('2 · authentication', () => {
  it('rejects bad credentials with one generic message', () => {
    signIn();
    const a = fails(A.call('', 'auth.login', { email: 'nobody@example.test', password: 'x1234567' }), /Invalid email or password/);
    const b = fails(A.call('', 'auth.login', { email: 'cm.b@example.test', password: 'wrongpass1' }), /Invalid email or password/);
    assert.equal(a.error, b.error, 'unknown user and wrong password must be indistinguishable');
  });
  it('locks the account on the 5th failure (reported on the next attempt) and unlocks after 15 minutes', () => {
    for (let i = 0; i < 5; i++) fails(A.call('', 'auth.login', { email: 'lab.bb@example.test', password: 'wrongpass' + i }), /Invalid email or password/);
    fails(A.call('', 'auth.login', { email: 'lab.bb@example.test', password: 'wrongpass9' }), /locked/i);
    fails(A.call('', 'auth.login', { email: 'lab.bb@example.test', password: PASSWORD }), /locked/i, 'correct password during lockout');
    A.advanceHours(16 / 60);
    ok(A.call('', 'auth.login', { email: 'lab.bb@example.test', password: PASSWORD }), 'sign-in after lockout window');
  });
  it('forgot-password issues a temp password by email, once per 10 minutes, without revealing whether the account exists', () => {
    A.clearMail();
    const a = A.call('', 'auth.forgot', { email: 'lab.bb@example.test' }); const b = A.call('', 'auth.forgot', { email: 'ghost@example.test' });
    ok(a); ok(b); assert.equal(a.data.message, b.data.message);
    const mails = A.mail().filter(m => /lab\.bb@/.test(m.to)); assert.equal(mails.length, 1);
    A.call('', 'auth.forgot', { email: 'lab.bb@example.test' });
    assert.equal(A.mail().filter(m => /lab\.bb@/.test(m.to)).length, 1, 'second request inside the cooldown must not issue another password');
    const t = mails[0].htmlBody.match(/Temporary password:<\/b> (\w+)/)[1];
    const r = A.call('', 'auth.login', { email: 'lab.bb@example.test', password: t }); ok(r); assert.equal(r.data.mustChangePassword, true);
    ok(A.call(r.data.token, 'auth.changePassword', { newPassword: PASSWORD, confirmPassword: PASSWORD }));
  });
  it('enforces the password policy on change', () => {
    const t = A.login('lab.bb@example.test');
    fails(A.call(t, 'auth.changePassword', { currentPassword: PASSWORD, newPassword: 'short1', confirmPassword: 'short1' }), /at least 8/);
    fails(A.call(t, 'auth.changePassword', { currentPassword: PASSWORD, newPassword: 'alllettersonly', confirmPassword: 'alllettersonly' }), /letter and one number/);
    fails(A.call(t, 'auth.changePassword', { currentPassword: PASSWORD, newPassword: 'has-symbol1!', confirmPassword: 'has-symbol1!' }), /alphanumeric/);
    fails(A.call(t, 'auth.changePassword', { currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD }), /different/);
    fails(A.call(t, 'auth.changePassword', { currentPassword: 'wrong1234', newPassword: 'Another123', confirmPassword: 'Another123' }), /Current password is incorrect/);
  });
  it('expires sessions after 12 hours and blocks unknown actions / wrong roles', () => {
    const t = A.login('cm.a@example.test');
    ok(A.call(t, 'boot', {}));
    fails(A.call(t, 'stmt.list', {}), /not permitted for your role/);
    fails(A.call(t, 'no.such.action', {}), /Unknown action/);
    fails(A.call('0'.repeat(48), 'boot', {}), /session has expired/);
    A.advanceHours(13);
    const r = fails(A.call(t, 'boot', {}), /session has expired/); assert.equal(r.code, 'SESSION_EXPIRED');
    signIn();
  });
});

describe('3 · lead capture', () => {
  it('boot is scoped: a clinic manager sees only their clinic and no margin figures', () => {
    const b = A.call(tok.cmA, 'boot', {}); ok(b);
    assert.deepEqual(b.data.clinics.map(c => c.id), ['CL-AAA']);
    const cat = b.data.catalogues['PT-AA']; assert.ok(cat.length >= 6);
    assert.ok(cat.every(i => i.margin === undefined && i.share === undefined), 'catalogue must not leak margin to a clinic');
    const adm = A.call(tok.admin, 'boot', {}); assert.equal(adm.data.clinics.length, 3);
    assert.ok(adm.data.catalogues['PT-AA'].every(i => i.margin !== undefined));
  });
  it('captures a valid lead: IDs, frozen prices, consent, visit number, M1 message', () => {
    const r = create({ patientName: 'Asha Test' }); ok(r, 'create');
    L.main = r.data.leadId;
    assert.match(L.main, /^GYN-261021-0001$/);
    assert.equal(r.data.patientPrice, 1200); assert.equal(r.data.mrp, 1600); assert.equal(r.data.partner, 'Alpha Diagnostics');
    assert.match(r.data.m1.link, /^https:\/\/wa\.me\/919000000011\?text=/);
    const row = A.rows('Leads').find(x => x.LeadID === L.main);
    assert.equal(row.Status, 'Lead generated'); assert.equal(row.RevenueState, 'Expected'); assert.equal(Number(row.ExpectedMarginRs), 400);
    assert.equal(String(row.VisitNumber), '1', 'VisitNumber must be persisted once the column exists');
    assert.equal(String(row.ConsentTicked).toUpperCase(), 'TRUE');
    const lines = A.rows('LeadTests').filter(x => x.LeadID === L.main);
    assert.deepEqual(lines.map(x => Number(x.FrozenPatientPrice)).sort(), [300, 900]);
  });
  it('emails the partner coordinators and lab managers about the new lead', () => {
    const to = A.mail().map(m => m.to).join(' ');
    assert.match(to, /pc\.aa@example\.test/); assert.match(to, /lb-aa-001@example\.test/);
  });
  it('refuses invalid input with specific messages', () => {
    fails(create({ consent: false }), /consent/i);
    fails(create({ phone: '1234567890' }), /valid 10-digit/);
    fails(create({ age: 17 }), /between 18 and 65/);
    fails(create({ pincode: '012345' }), /6-digit pincode/);
    fails(create({ visitNumber: undefined }), /which clinic visit/);
    fails(create({ referringDoctor: 'Dr. Nobody' }), /referring doctor/);
    fails(create({ items: [] }), /at least one/);
    fails(create({ items: [{ code: 'TST-999', tag: 'P' }] }), /not on the partner's active rate card/);
    fails(create({ items: [{ code: 'TST-005', tag: 'P' }] }), /male-only/);
    fails(create({ items: [{ code: 'PKG-01', tag: 'P' }] }), /Switch Booking Type to Couple/);
    fails(create({ bookingType: 'Couple', spouseName: 'S', spouseAge: 30, spouseGender: 'M', items: [{ code: 'TST-001', tag: 'P' }] }), /spouse/i);
  });
  it('blocks capture for a paused clinic and outside the manager’s own clinic', () => {
    fails(A.call(tok.admin, 'lead.create', mkLead({ clinicId: 'CL-CCC' })), /Paused/);
    fails(A.call(tok.cmA, 'lead.create', mkLead({ clinicId: 'CL-BBB' })), /your own clinic/);
  });
  it('warns on a duplicate phone + overlapping test, then files a review when acknowledged', () => {
    const dc = A.call(tok.cmA, 'lead.dupcheck', { clinicId: 'CL-AAA', phone: '9000000011', codes: ['TST-001'] });
    ok(dc); assert.equal(dc.data.matches.length, 1); assert.equal(dc.data.matches[0].leadId, L.main);
    const r = fails(create({ phone: '9000000011' }), /overlapping test/); assert.equal(r.code, 'DUPLICATE_WARNING');
    const ack = A.call(tok.cmA, 'lead.create', mkLead({ phone: '9000000011', acknowledgeDuplicate: true })); ok(ack);
    L.dup = ack.data.leadId; assert.deepEqual(ack.data.duplicates, [L.main]);
    assert.equal(A.rows('DuplicateReviews').filter(d => d.DuplicateLeadID === L.dup).length, 1);
  });
  it('books a package for a couple: header + female/male components, one package price', () => {
    const r = create({ patientName: 'Couple Test', bookingType: 'Couple', spouseName: 'Spouse Test', spouseAge: 33, spouseGender: 'M', items: [{ code: 'PKG-01', tag: 'B' }] });
    ok(r, 'couple package'); L.couple = r.data.leadId; assert.equal(r.data.patientPrice, 1400);
    const lines = A.rows('LeadTests').filter(x => x.LeadID === L.couple);
    assert.equal(lines.length, 4); assert.equal(lines.filter(x => x.ItemType === 'PackageComponent').length, 3);
    assert.deepEqual(lines.filter(x => x.ItemType === 'PackageComponent').map(x => x.PersonTag).sort(), ['P', 'P', 'S']);
  });
  it('accepts a male patient for a male-only test', () => {
    const r = create({ patientName: 'Male Patient', gender: 'M', items: [{ code: 'TST-005', tag: 'P' }] }); ok(r); L.male = r.data.leadId;
  });
  it('stores and serves a prescription photo, rejecting non-images without blocking capture', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
    const r = A.call(tok.cmA, 'lead.create', mkLead({ rxB64: jpeg })); ok(r); L.rx = r.data.leadId;
    assert.deepEqual(r.data.warnings, []);
    const g = A.call(tok.cmA, 'lead.getPrescription', { leadId: L.rx }); ok(g);
    assert.equal(g.data.mime, 'image/jpeg'); assert.equal(g.data.fileName, L.rx + '.jpg');
    assert.equal(Buffer.from(g.data.b64, 'base64')[0], 0xff, 'signed-byte handling: JPEG magic must round-trip');
    const bad = A.call(tok.cmA, 'lead.create', mkLead({ rxB64: Buffer.alloc(200, 1).toString('base64') }));
    ok(bad, 'a bad photo must not block capture'); assert.match(bad.data.warnings.join(' '), /JPG or PNG/);
  });
  it('hides a lead from other clinics and other partners', () => {
    fails(A.call(tok.cmB, 'lead.get', { leadId: L.main }), /outside your access scope/);
    fails(A.call(tok.pcB, 'lead.get', { leadId: L.main }), /outside your access scope/);
    assert.equal(A.call(tok.pcB, 'leads.queue', {}).data.items.length, 0);
  });
});

describe('4 · status workflow', () => {
  it('enforces who may move a lead and what each move needs', () => {
    fails(go(tok.cmA, L.main, 'Called by lab', { note: 'x' }), /can't move a lead/);
    fails(go(tok.pcA, L.main, 'Called by lab'), /call summary/);
    fails(go(tok.pcA, L.main, 'Test booked'), /can't move to/);
    fails(go(tok.pcA, L.main, 'Called by lab', { note: 'ok', expectedStatus: 'Test booked' }), /just updated by someone else/);
    ok(go(tok.pcA, L.main, 'Called by lab', { note: 'Spoke to patient', expectedStatus: 'Lead generated' }));
    assert.equal(status(L.main), 'Called by lab');
  });
  it('books, then validates lab, date, slot and mode when scheduling', () => {
    ok(go(tok.pcA, L.main, 'Test booked'));
    fails(go(tok.pcA, L.main, 'Lab visit scheduled', { labId: 'LB-BB-001', apptDate: TOMORROW, apptSlot: '10:30' }), /different partner/);
    fails(go(tok.pcA, L.main, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: '2026-10-20', apptSlot: '10:30' }), /in the past/);
    fails(go(tok.pcA, L.main, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '' }), /time \/ slot/);
    fails(go(tok.pcA, L.main, 'Home sample collection', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '9:00' }), /address/);
    ok(go(tok.pcA, L.main, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '10:30' }));
    const d = detail(L.main, tok.pcA); assert.equal(d.lead.AssignedLabID, 'LB-AA-001'); assert.equal(d.lead.BookingMode, 'Lab visit');
  });
  it('M2 appears on scheduling and reschedule fires M6', () => {
    const d = detail(L.main, tok.pcA); assert.ok(d.messages.some(m => m.code === 'M2'));
    const r = A.call(tok.pcA, 'lead.reschedule', { leadId: L.main, apptDate: '2026-10-23', apptSlot: '11:00' }); ok(r, 'reschedule');
    assert.equal(r.data.message.code, 'M6');
    ok(A.call(tok.pcA, 'lead.reschedule', { leadId: L.main, apptDate: TOMORROW, apptSlot: '10:30' }));
  });
  it('imaging cannot be collected at home, and a pathology-only lab cannot take an imaging lead', () => {
    const r = create({ items: [{ code: 'TST-003', tag: 'P' }] }); ok(r); L.img = r.data.leadId;
    ok(go(tok.pcA, L.img, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, L.img, 'Test booked'));
    fails(go(tok.pcA, L.img, 'Home sample collection', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '9:00', collectionAddress: '12 Test Road, Mumbai' }), /Home collection/);
    fails(go(tok.pcA, L.img, 'Lab visit scheduled', { labId: 'LB-AA-002', apptDate: TOMORROW, apptSlot: '9:00' }), /doesn't perform/);
  });
  it('home collection works for pathology at a served pincode and is refused elsewhere', () => {
    const r = create({ pincode: '400001' }); ok(r); L.home = r.data.leadId;
    ok(go(tok.pcA, L.home, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, L.home, 'Test booked'));
    ok(go(tok.pcA, L.home, 'Home sample collection', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '8:00', collectionAddress: '12 Test Road, Mumbai 400001' }));
    assert.equal(detail(L.home).lead.BookingMode, 'Home collection');
    const far = create({ pincode: '560001' }); ok(far); L.far = far.data.leadId;
    ok(go(tok.pcA, L.far, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, L.far, 'Test booked'));
    fails(go(tok.pcA, L.far, 'Home sample collection', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '8:00', collectionAddress: '99 Far Road, Bengaluru' }), /home collection for pincode/);
  });
  it('not-reachable needs a reason and a future retry; follow-ups pause the SLA; not-interested voids revenue', () => {
    const nr = create({}); ok(nr); L.nr = nr.data.leadId;
    fails(go(tok.pcA, L.nr, 'Not reachable', { reason: 'No answer', retryAt: '2026-10-20 10:00' }), /future/);
    fails(go(tok.pcA, L.nr, 'Not reachable', { retryAt: '2026-10-22 10:00' }), /why the patient was not reachable/);
    ok(go(tok.pcA, L.nr, 'Not reachable', { reason: 'No answer', retryAt: '2026-10-22 10:00' }));
    ok(go(tok.pcA, L.nr, 'Called by lab', { note: 'reached on retry' }));
    fails(go(tok.pcA, L.nr, 'Follow-up: Will do later', { followUpDate: TODAY, reason: 'Travelling' }), /future date/);
    ok(go(tok.pcA, L.nr, 'Follow-up: Will do later', { followUpDate: '2026-10-25', reason: 'Travelling' }));
    assert.ok(detail(L.nr, tok.pcA).sla.paused);
    ok(go(tok.pcA, L.nr, 'Called by lab', { note: 'back early' }));
    fails(go(tok.pcA, L.nr, 'Not interested', { reason: 'Other (text)' }), /Describe the reason/);
    ok(go(tok.pcA, L.nr, 'Not interested', { reason: 'Price' }));
    assert.equal(A.rows('Leads').find(x => x.LeadID === L.nr).RevenueState, 'Void');
    fails(go(tok.pcA, L.nr, 'Called by lab', { note: 'revive' }), /can't move|role/, 'only Admin revives');
    ok(go(tok.admin, L.nr, 'Called by lab', { note: 'revived by admin' }));
    assert.equal(A.rows('Leads').find(x => x.LeadID === L.nr).RevenueState, 'Expected');
  });
  it('a clinic manager can cancel only a freshly generated lead', () => {
    const r = create({}); ok(r);
    ok(go(tok.cmA, r.data.leadId, 'Cancelled', { reason: 'Duplicate', note: 'entered twice' }));
    fails(go(tok.cmA, L.main, 'Cancelled', { reason: 'Price' }), /can't move|role/);
  });
  it('the unreachable-lead cancel is Admin-only and respects the 14-day rule', () => {
    const r = create({}); ok(r);
    ok(go(tok.pcA, r.data.leadId, 'Not reachable', { reason: 'No answer', retryAt: '2026-10-22 10:00' }));
    fails(go(tok.admin, r.data.leadId, 'Cancelled', { reason: 'No response' }), /after 14 days/);
    const w = create({}); ok(w);
    ok(go(tok.pcA, w.data.leadId, 'Not reachable', { reason: 'Wrong number', retryAt: '2026-10-22 10:00' }));
    ok(go(tok.admin, w.data.leadId, 'Cancelled', { reason: 'Wrong number' }), 'wrong number may be cancelled immediately');
  });
});

describe('5 · lab progress, multi-visit scans, payment and reports', () => {
  it('lab user sees only their lab’s leads and no commercial fields', () => {
    const q = A.call(tok.labA, 'leads.queue', {}); ok(q);
    assert.deepEqual(q.data.items.map(i => i.id).sort(), [L.home, L.main].sort());
    const d = detail(L.main, tok.labA);
    for (const k of ['ExpectedMarginRs', 'RevenueState', 'ExpectedMRP', 'PaymentAmount']) assert.equal(d.lead[k], undefined, k + ' must be hidden from the lab');
    assert.ok(d.lines.every(l => l.FrozenMarginRs === undefined && l.PartnerShareRs === undefined && l.FrozenMRP === undefined));
    fails(A.call(tok.labA, 'lead.get', { leadId: L.couple }), /outside your access scope/);
  });
  it('Sample collected can only be reached through Log progress', () => {
    fails(go(tok.labA, L.main, 'Sample collected'), /Log progress/);
    fails(go(tok.labA, L.main, 'Test done'), /can't move/);
  });
  it('multi-visit scan: needs a next-scan date until the last visit, then M5, then Test done', () => {
    const r = create({ items: [{ code: 'TST-004', tag: 'P' }] }); ok(r); L.scan = r.data.leadId;
    ok(go(tok.pcA, L.scan, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, L.scan, 'Test booked'));
    ok(go(tok.pcA, L.scan, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '9:00' }));
    const [lt] = lineIds(L.scan);
    fails(A.call(tok.labA, 'lead.progress', { leadId: L.scan, updates: [{ leadTestId: lt }] }), /next scan date/);
    const s1 = A.call(tok.labA, 'lead.progress', { leadId: L.scan, updates: [{ leadTestId: lt }], nextScanDate: '2026-10-25' }); ok(s1, 'scan 1');
    assert.equal(s1.data.status, 'Sample collected'); assert.equal(s1.data.message.code, 'M5'); assert.match(s1.data.message.text, /scan 2/);
    assert.equal(s1.data.allDone, false);
    fails(go(tok.labA, L.scan, 'Test done'), /Pending.*1\/3/);
    ok(A.call(tok.labA, 'lead.progress', { leadId: L.scan, updates: [{ leadTestId: lt }], nextScanDate: '2026-10-28' }), 'scan 2');
    const s3 = A.call(tok.labA, 'lead.progress', { leadId: L.scan, updates: [{ leadTestId: lt }] }); ok(s3, 'scan 3 needs no next date');
    assert.equal(s3.data.allDone, true);
    ok(go(tok.labA, L.scan, 'Test done'));
  });
  it('a lab user cannot undo a completed test; the coordinator can — but only while the lead is still in progress', () => {
    const r = create({}); ok(r); const id = r.data.leadId;
    ok(go(tok.pcA, id, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, id, 'Test booked'));
    ok(go(tok.pcA, id, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '9:30' }));
    const [first] = lineIds(id);
    ok(A.call(tok.labA, 'lead.progress', { leadId: id, updates: [{ leadTestId: first }] }));
    fails(A.call(tok.labA, 'lead.progress', { leadId: id, updates: [{ leadTestId: first, undo: true }] }), /Partner Coordinator/);
    ok(A.call(tok.pcA, 'lead.progress', { leadId: id, updates: [{ leadTestId: first, undo: true }] }), 'coordinator undo');
    assert.equal(detail(id).lines.find(l => l.LeadTestID === first).IsDone, false);
    fails(A.call(tok.pcA, 'lead.progress', { leadId: L.scan, updates: [{ leadTestId: lineIds(L.scan)[0], undo: true }] }), /once the appointment is scheduled/, 'after Test done nobody can log progress');
  });
  it('completes the main lead: Test done without payment for a lab user, then the coordinator records payment', () => {
    const ids = lineIds(L.main);
    const p = A.call(tok.labA, 'lead.progress', { leadId: L.main, updates: [{ leadTestId: ids[0] }] }); ok(p);
    fails(go(tok.labA, L.main, 'Test done'), /Pending/);
    ok(A.call(tok.labA, 'lead.progress', { leadId: L.main, updates: [{ leadTestId: ids[1] }] }));
    ok(go(tok.labA, L.main, 'Test done'));
    const row = A.rows('Leads').find(x => x.LeadID === L.main); assert.equal(row.RevenueState, 'Earned'); assert.ok(row.TestDoneAt);
    fails(A.call(tok.pcA, 'lead.payment', { leadId: L.main, paymentAmount: 1200, paymentMode: 'Bitcoin', paymentDate: TODAY }), /payment mode/);
    fails(A.call(tok.pcA, 'lead.payment', { leadId: L.main, paymentAmount: 1200, paymentMode: 'UPI', paymentDate: '2026-12-01' }), /future/);
    fails(A.call(tok.labA, 'lead.payment', { leadId: L.main, paymentAmount: 1200, paymentMode: 'UPI', paymentDate: TODAY }), /not permitted/);
    ok(A.call(tok.pcA, 'lead.payment', { leadId: L.main, paymentAmount: 1200, paymentMode: 'UPI', paymentDate: TODAY, paymentRef: 'UPI-1' }));
  });
  it('rejects non-PDF and truncated PDFs, accepts a real one, and keeps patient names out of the file name', () => {
    fails(A.call(tok.labA, 'report.upload', { leadId: L.main, personTag: 'P', b64: pdfB64({ noHeader: true }) }), /Only PDF/);
    fails(A.call(tok.labA, 'report.upload', { leadId: L.main, personTag: 'P', b64: pdfB64({ noEof: true }) }), /incomplete/);
    fails(A.call(tok.labA, 'report.upload', { leadId: L.main, personTag: 'P', b64: '' }), /Choose a PDF/);
    fails(go(tok.labA, L.main, 'Test report generated'), /Upload a report PDF/);
    const r = A.call(tok.labA, 'report.upload', { leadId: L.main, personTag: 'P', fileName: 'Asha Test.pdf', b64: pdfB64(), markGenerated: true }); ok(r);
    assert.equal(r.data.transitioned.status, 'Test report generated');
    const rep = A.rows('Reports').find(x => x.LeadID === L.main); assert.equal(rep.FileName, L.main + '-1.pdf'); assert.doesNotMatch(rep.DrivePath, /Asha/);
    const g = A.call(tok.cmA, 'report.get', { reportId: rep.ReportID }); ok(g); assert.equal(Buffer.from(g.data.b64, 'base64').subarray(0, 4).toString(), '%PDF');
    assert.ok(A.rows('Audit').some(a => a.Action === 'REPORT_VIEWED' && a.LeadID === L.main), 'every view is audited');
    assert.ok(A.mail().some(m => /clinic|cm|cl-aaa/i.test(m.to) && /Report ready/.test(m.subject)), 'clinic is emailed when the report is ready');
  });
  it('a couple needs a report for each person before Test report generated', () => {
    advanceCouple();
    const d = detail(L.couple);
    assert.deepEqual(d.missingReports.sort(), ['P', 'S']);
    ok(A.call(tok.labA, 'report.upload', { leadId: L.couple, personTag: 'P', b64: pdfB64() }));
    fails(go(tok.labA, L.couple, 'Test report generated'), /spouse/);
    ok(A.call(tok.labA, 'report.upload', { leadId: L.couple, personTag: 'S', b64: pdfB64(), markGenerated: true }));
    assert.equal(status(L.couple), 'Test report generated');
  });
  function advanceCouple() {
    ok(go(tok.pcA, L.couple, 'Called by lab', { note: 'Spoke to patient' })); ok(go(tok.pcA, L.couple, 'Test booked'));
    ok(go(tok.pcA, L.couple, 'Lab visit scheduled', { labId: 'LB-AA-001', apptDate: TOMORROW, apptSlot: '12:00' }));
    ok(A.call(tok.labA, 'lead.progress', { leadId: L.couple, updates: lineIds(L.couple).map(x => ({ leadTestId: x })) }));
    ok(go(tok.labA, L.couple, 'Test done'));
    ok(A.call(tok.pcA, 'lead.payment', { leadId: L.couple, paymentAmount: 1400, paymentMode: 'Cash', paymentDate: TODAY }));
  }
});

describe('6 · test edits and re-pricing', () => {
  it('adding a test prices it on the rate card the lead was captured against and marks revenue Re-priced', () => {
    const r = create({}); ok(r); L.edit = r.data.leadId;
    ok(go(tok.pcA, L.edit, 'Called by lab', { note: 'Spoke to patient' }));
    const before = A.rows('Leads').find(x => x.LeadID === L.edit);
    const a = A.call(tok.pcA, 'lead.addItem', { leadId: L.edit, code: 'TST-003', tag: 'P' }); ok(a);
    const after = A.rows('Leads').find(x => x.LeadID === L.edit);
    assert.equal(Number(after.ExpectedPatientPrice), Number(before.ExpectedPatientPrice) + 700); assert.equal(after.RevenueState, 'Re-priced');
    fails(A.call(tok.pcA, 'lead.addItem', { leadId: L.edit, code: 'TST-003', tag: 'P' }), /already on this lead/);
  });
  it('removing a test needs a note, and the last test cannot be removed', () => {
    const lt = detail(L.edit).lines.find(l => l.ItemCode === 'TST-003').LeadTestID;
    fails(A.call(tok.pcA, 'lead.removeLine', { leadId: L.edit, leadTestId: lt }), /note/);
    ok(A.call(tok.pcA, 'lead.removeLine', { leadId: L.edit, leadTestId: lt, note: 'patient declined scan' }));
    const rest = lineIds(L.edit);
    ok(A.call(tok.pcA, 'lead.removeLine', { leadId: L.edit, leadTestId: rest[0], note: 'drop one' }));
    fails(A.call(tok.pcA, 'lead.removeLine', { leadId: L.edit, leadTestId: rest[1], note: 'drop last' }), /last test/);
  });
  it('only the Admin can override a frozen price, with a note and sane numbers', () => {
    const lt = lineIds(L.edit)[0];
    fails(A.call(tok.pcA, 'lead.overrideLine', { leadId: L.edit, leadTestId: lt, mrp: 500, price: 400, margin: 100, note: 'x' }), /not permitted/);
    fails(A.call(tok.admin, 'lead.overrideLine', { leadId: L.edit, leadTestId: lt, mrp: 500, price: 600, margin: 100, note: 'discount fix' }), /≤ MRP/);
    fails(A.call(tok.admin, 'lead.overrideLine', { leadId: L.edit, leadTestId: lt, mrp: 500, price: 400, margin: 400, note: 'discount fix' }), /less than the patient price/);
    ok(A.call(tok.admin, 'lead.overrideLine', { leadId: L.edit, leadTestId: lt, mrp: 500, price: 400, margin: 120, note: 'negotiated price' }));
    assert.equal(Number(A.rows('Leads').find(x => x.LeadID === L.edit).ExpectedMarginRs), 120);
  });
  it('a clinic manager can edit patient details only while the lead is Lead generated', () => {
    const r = create({}); ok(r);
    ok(A.call(tok.cmA, 'lead.edit', { leadId: r.data.leadId, fields: { PatientName: 'Renamed Patient', Age: 41 } }));
    fails(A.call(tok.cmA, 'lead.edit', { leadId: r.data.leadId, fields: { Status: 'Closed' } }), /can't be edited here/);
    fails(A.call(tok.cmA, 'lead.edit', { leadId: r.data.leadId, fields: { Phone: '12345' } }), /Invalid mobile/);
    ok(go(tok.pcA, r.data.leadId, 'Called by lab', { note: 'Spoke to patient' }));
    fails(A.call(tok.cmA, 'lead.edit', { leadId: r.data.leadId, fields: { Age: 42 } }), /only while it is "Lead generated"/);
  });
  it('re-routing to another partner reprices onto the new partner’s card and clears the lab', () => {
    const r = create({}); ok(r);
    const id = r.data.leadId;
    const before = A.rows('Leads').find(x => x.LeadID === id);
    const rr = A.call(tok.admin, 'lead.reroute', { leadId: id, clinicId: 'CL-BBB', partnerId: 'PT-BB', note: 'wrong region' }); ok(rr, 'reroute');
    const after = A.rows('Leads').find(x => x.LeadID === id);
    assert.equal(after.PartnerID, 'PT-BB'); assert.equal(after.ClinicID, 'CL-BBB'); assert.equal(Number(after.ExpectedPatientPrice), Number(before.ExpectedPatientPrice));
    assert.equal(A.call(tok.pcB, 'leads.queue', {}).data.items.some(i => i.id === id), true);
    assert.equal(A.call(tok.pcA, 'leads.queue', {}).data.items.some(i => i.id === id), false);
  });
});

describe('7 · settlement: statements, disputes, transfers, FIFO, closure', () => {
  let stmt;
  it('only the Admin generates a statement; it lists exactly the eligible Test-done leads', () => {
    fails(A.call(tok.pcA, 'stmt.generate', { partnerId: 'PT-AA', month: '2026-10' }), /not permitted/);
    fails(A.call(tok.admin, 'stmt.generate', { partnerId: 'PT-AA', month: '2026-12' }), /future month/);
    const r = A.call(tok.admin, 'stmt.generate', { partnerId: 'PT-AA', month: '2026-10' }); ok(r, 'generate');
    stmt = r.data.statementId; assert.equal(stmt, 'STMT-AA-202610');
    const lines = A.rows('StatementLines').filter(x => x.StatementID === stmt);
    assert.deepEqual(lines.map(x => x.LeadID).sort(), [L.couple, L.main, L.scan].sort());
    assert.equal(lines.find(x => x.LeadID === L.main).ContractualMarginRs, 400);
    assert.match(A.mail().map(m => m.subject).join('|'), /Monthly statement STMT-AA-202610 ready/);
    fails(A.call(tok.admin, 'stmt.generate', { partnerId: 'PT-AA', month: '2026-10' }), /already includes every eligible lead/);
  });
  it('the coordinator sees only their own partner’s statements', () => {
    assert.equal(A.call(tok.pcA, 'stmt.list', {}).data.statements.length, 1);
    assert.equal(A.call(tok.pcB, 'stmt.list', {}).data.statements.length, 0);
    fails(A.call(tok.pcB, 'stmt.lines', { statementId: stmt }), /Statement not found/);
    assert.deepEqual(A.call(tok.pcA, 'stmt.list', {}).data.transfers, [], 'transfers are Admin-only');
  });
  it('a flagged line freezes revenue and moves the lead to Disputed; resolving restores it', () => {
    const line = A.rows('StatementLines').find(x => x.LeadID === L.scan);
    fails(A.call(tok.pcA, 'stmt.flagLine', { statementLineId: line.StatementLineID, note: 'no' }), /Describe the discrepancy/);
    ok(A.call(tok.pcA, 'stmt.flagLine', { statementLineId: line.StatementLineID, note: 'patient did not attend scan 3' }));
    assert.equal(status(L.scan), 'Disputed'); assert.equal(A.rows('Leads').find(x => x.LeadID === L.scan).RevenueState, 'Frozen');
    assert.equal(A.rows('Statements').find(x => x.StatementID === stmt).TotalTestDoneLeads, 2, 'flagged line drops off the statement total');
    assert.equal(A.call(tok.admin, 'dispute.list', {}).data.disputed.length, 1);
    fails(A.call(tok.pcA, 'stmt.resolveLine', { statementLineId: line.StatementLineID, resolution: 'valid', note: 'self-resolve' }), /not permitted/);
    ok(A.call(tok.admin, 'stmt.resolveLine', { statementLineId: line.StatementLineID, resolution: 'valid', note: 'attendance confirmed by lab' }));
    assert.equal(status(L.scan), 'Test done'); assert.equal(A.rows('Leads').find(x => x.LeadID === L.scan).RevenueState, 'Earned');
    assert.equal(A.rows('Statements').find(x => x.StatementID === stmt).TotalTestDoneLeads, 3);
  });
  it('the partner’s review window closes after STATEMENT_DISPUTE_WINDOW_DAYS', () => {
    const line = A.rows('StatementLines').find(x => x.LeadID === L.couple);
    A.advanceHours(24 * 4);
    try {
      signIn();
      fails(A.call(tok.pcA, 'stmt.flagLine', { statementLineId: line.StatementLineID, note: 'too late to dispute this' }), /review window.*closed/);
    } finally { A.advanceHours(-24 * 4); signIn(); }
  });
  it('confirmation is a one-time partner action', () => {
    ok(A.call(tok.pcA, 'stmt.confirm', { statementId: stmt }));
    fails(A.call(tok.pcA, 'stmt.confirm', { statementId: stmt }), /already confirmed/);
    assert.equal(A.rows('Statements').find(x => x.StatementID === stmt).Status, 'Confirmed');
  });
  it('records a transfer, rejects a duplicate UTR, and allocates FIFO to the paisa across a partial payment', () => {
    const rec = (amt, utr, extra) => A.call(tok.admin, 'transfer.record', Object.assign({ partnerId: 'PT-AA', transferDate: TODAY, amountRs: amt, paymentMode: 'NEFT', utr: utr }, extra || {}));
    fails(rec(0, 'UTR0001'), /greater than 0/); fails(rec(100, 'X'), /UTR/);
    fails(A.call(tok.pcA, 'transfer.record', { partnerId: 'PT-AA', transferDate: TODAY, amountRs: 100, paymentMode: 'NEFT', utr: 'UTRPC1' }), /not permitted/);
    const t1 = rec(150.55, 'utr-000111'); ok(t1, 'first transfer');
    assert.equal(t1.data.allocation.allocated, 150.55); assert.equal(t1.data.allocation.unallocatedCredit, 0);
    fails(rec(10, 'UTR-000111'), /already recorded/, 'UTR comparison is case-insensitive');
    const allocs = A.rows('Allocations'); assert.equal(allocs.length, 1);
    const firstLine = A.rows('StatementLines').find(x => x.LeadID === allocs[0].LeadID);
    assert.equal(firstLine.TestDoneDate, '2026-10-21');
    const total = A.rows('StatementLines').reduce((a, x) => a + Number(x.ContractualMarginRs), 0);
    assert.equal(total, 400 + 600 + 400, 'main 400 + scan 600 + couple 400');
  });
  it('TDS counts toward the credit; an overpayment is held as unallocated credit', () => {
    const t = A.call(tok.admin, 'transfer.record', { partnerId: 'PT-AA', transferDate: TODAY, amountRs: 1300, tdsDeductedRs: 49.45, paymentMode: 'RTGS', utr: 'UTR-OVER-1' }); ok(t);
    const sum = A.rows('Allocations').reduce((a, x) => a + Number(x.AllocatedAmountRs), 0);
    assert.equal(Math.round(sum * 100) / 100, 1400, 'all three lines (₹1,400) fully allocated');
    assert.equal(t.data.allocation.unallocatedCredit, Math.round((150.55 + 1300 + 49.45 - 1400) * 100) / 100);
    assert.ok(A.rows('StatementLines').every(x => x.LineStatus === 'Collected'));
    assert.ok(A.rows('Leads').filter(x => [L.main, L.scan, L.couple].includes(x.LeadID)).every(x => x.RevenueState === 'Collected'));
    for (const tr of A.rows('Transfers')) assert.equal(Math.round((Number(tr.AllocatedAmountRs) + Number(tr.UnallocatedAmountRs)) * 100) / 100, Math.round((Number(tr.AmountRs) + Number(tr.TDSDeductedRs)) * 100) / 100, 'transfer ' + tr.TransferID + ' must balance');
  });
  it('leftover credit is applied automatically to the next statement', () => {
    const r = create({}); ok(r); L.late = r.data.leadId; advance(L.late, 'report');
    const g = A.call(tok.admin, 'stmt.generate', { partnerId: 'PT-AA', month: '2026-10' }); ok(g, 'regenerate');
    assert.equal(g.data.added, 1); assert.equal(g.data.allocation.allocated, 100, 'the ₹100 credit covers the new ₹400 line partly');
    assert.equal(A.rows('StatementLines').find(x => x.LeadID === L.late).LineStatus, 'Partially collected');
  });
  it('closes only leads that have a report and collected commission', () => {
    const r = A.call(tok.admin, 'stmt.closeEligible', {}); ok(r);
    assert.equal(r.data.closed, 2, 'main + couple have reports and are Collected; scan has no report; late is only partly collected');
    assert.equal(status(L.main), 'Closed'); assert.equal(status(L.couple), 'Closed'); assert.equal(status(L.scan), 'Test done');
    fails(go(tok.admin, L.late, 'Closed'), /Collected/);
    fails(go(tok.pcA, L.main, 'Test done'), /can't move/);
    assert.ok(A.rows('Leads').find(x => x.LeadID === L.main).ClosedAt);
  });
  it('a closed lead can be reopened by the Admin only within the window', () => {
    // CLOSED has no outbound transitions in the matrix — reopening is for Not interested / Cancelled leads
    assert.equal(A.ev('TRANSITIONS.filter(t => t[0] === ST.CLOSED).length'), 0);
  });
});

describe('8 · dashboards', () => {
  it('dash.summary is internally consistent', () => {
    const s = A.call(tok.admin, 'dash.summary', {}); ok(s); const d = s.data;
    const leads = A.rows('Leads');
    assert.equal(d.totals.leads, leads.length);
    assert.equal(d.funnel[0].count, leads.length);
    for (let i = 1; i < d.funnel.length; i++) assert.ok(d.funnel[i].count <= d.funnel[i - 1].count, 'funnel must narrow: ' + d.funnel[i].stage);
    assert.equal(Object.values(d.statusCounts).reduce((a, b) => a + b, 0), leads.length);
    assert.equal(d.partners.reduce((a, p) => a + p.leads, 0), leads.length);
    assert.equal(d.byVisit.reduce((a, v) => a + v.leads, 0), leads.length);
    assert.ok(d.kpis.every(k => ['good', 'warn', 'bad', 'na'].includes(k.status)));
    assert.ok(d.partners.every(p => p.margin !== undefined), 'admin sees margin');
  });
  it('dash.summary is Admin-only and cached responses are invalidated by any write', () => {
    fails(A.call(tok.pcA, 'dash.summary', {}), /not permitted/);
    const a = A.call(tok.admin, 'dash.summary', {}).data.totals.leads;
    ok(create({})); const b = A.call(tok.admin, 'dash.summary', {}).data.totals.leads;
    assert.equal(b, a + 1, 'a write must bust the 45-second dashboard cache');
  });
  it('dash.monthly reports real numbers for the month', () => {
    A.advanceHours(0); advance(L.male, 'done');           // a completed male-patient test
    const r = A.call(tok.admin, 'dash.monthly', { months: 2 }); ok(r);
    const m = r.data.months.find(x => x.month === '2026-10'); assert.ok(m, 'current month present');
    const leads = A.rows('Leads');
    assert.equal(m.leads, leads.length);
    assert.equal(m.liveClinics, new Set(leads.map(l => l.ClinicID)).size);
    assert.equal(m.maleTest + m.femaleTest, m.noOfTests, 'male + female tests must add up to the total');
    assert.ok(m.maleTest > 0, 'a male patient with a completed test exists, so the male count must be > 0');
    assert.equal(m.maleTest, 1, 'the male patient has exactly one completed test (TST-005)');
    const sum = k => leads.reduce((a, l) => a + Number(l[k] || 0), 0);
    assert.equal(m.gynoMarginPct, Math.round(sum('ExpectedMarginRs') / sum('ExpectedPatientPrice') * 1000) / 10, 'margin % = expected margin ÷ expected patient price');
    assert.ok(m.gynoMarginPct > 0 && m.gynoMarginPct < 100);
  });
});

describe('9 · Admin tools', () => {
  it('users.list never exposes password hashes; saving a user can issue a temp password', () => {
    const l = A.call(tok.admin, 'users.list', {}); ok(l); assert.ok(!JSON.stringify(l.data).includes('p2$'), 'no hash in the response');
    assert.equal(l.data.length, 7);
    const s = A.call(tok.admin, 'users.save', { user: { Email: 'new.cm@example.test', Name: 'New CM', Mobile: '9000000777', Role: 'Clinic Manager', OrgID: 'CL-BBB' }, sendTempPassword: true });
    ok(s); assert.match(s.data.userId, /^USR-CM-\d{3}$/); assert.ok(s.data.temp.tempPassword);
    fails(A.call(tok.admin, 'users.save', { user: { Email: 'NEW.CM@example.test', Name: 'Dup', Mobile: '9000000778', Role: 'Clinic Manager', OrgID: 'CL-BBB' } }), /already has a login/);
    fails(A.call(tok.admin, 'users.save', { user: { Email: 'x@example.test', Name: 'Xy', Mobile: '123', Role: 'Clinic Manager', OrgID: 'CL-BBB' } }), /10-digit/);
    fails(A.call(tok.admin, 'users.setActive', { userId: 'USR-ADM-01', active: false }), /deactivate yourself/);
    ok(A.call(tok.admin, 'users.setActive', { userId: s.data.userId, active: false }));
    fails(A.call('', 'auth.login', { email: 'new.cm@example.test', password: s.data.temp.tempPassword }), /Invalid/);
  });
  it('master data: lists, edits and validates; active rate-card prices are frozen', () => {
    const l = A.call(tok.admin, 'md.list', { table: 'Tests' }); ok(l); assert.equal(l.data.total, 5);
    fails(A.call(tok.admin, 'md.list', { table: 'Users' }), /Unknown table/);
    const rc = A.call(tok.admin, 'md.list', { table: 'RateCards', partnerId: 'PT-AA' }).data.rows[0];
    fails(A.call(tok.admin, 'md.save', { table: 'RateCards', row: { RateCardID: rc.RateCardID, PatientPrice: 1 }, note: 'x' }), /frozen/);
    fails(A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'MSG_MODE', Value: 'CARRIER_PIGEON' } }), /MANUAL or API/);
    ok(A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'SLA_CALL_HOURS', Value: '30' }, note: 'x' }));
    assert.equal(A.ev('cfgNum_("SLA_CALL_HOURS")'), 30);
    ok(A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'SLA_CALL_HOURS', Value: '24' }, note: 'restore' }));
  });
  it('partner validation passes for a complete partner and blocks an incomplete one; activation needs the checklist', () => {
    const good = A.call(tok.admin, 'partner.validate', { partnerId: 'PT-AA' }); ok(good); assert.deepEqual(good.data.errors, [], 'PT-AA should validate clean');
    const draft = A.call(tok.admin, 'partner.validate', { partnerId: 'PT-CC' }); ok(draft); assert.deepEqual(draft.data.errors, []);
    fails(A.call(tok.admin, 'partner.activate', { partnerId: 'PT-CC', checklist: { agreement: true }, note: '' }), /4-point/);
    ok(A.call(tok.admin, 'partner.activate', { partnerId: 'PT-CC', checklist: { agreement: true, ratecard: true, nabl: true, testcall: true }, note: 'verified on call' }));
    assert.equal(A.rows('Partners').find(p => p.PartnerID === 'PT-CC').State, 'Active');
    assert.equal(A.rows('Labs').find(l => l.LabID === 'LB-CC-001').State, 'Active');
    assert.ok(A.rows('RateCards').filter(r => r.PartnerID === 'PT-CC').every(r => r.State === 'Active'));
    ok(A.call(tok.admin, 'partner.setState', { partnerId: 'PT-CC', state: 'Suspended', note: 'contract paused' }));
  });
  it('rate-card versions: copy forward, then activate on the effective date', () => {
    fails(A.call(tok.admin, 'rc.newVersion', { partnerId: 'PT-AA', version: 'v2.0', effectiveFrom: '2026-10-01' }), /today or later/);
    const nv = A.call(tok.admin, 'rc.newVersion', { partnerId: 'PT-AA', version: 'v2.0', effectiveFrom: '2026-11-01' }); ok(nv); assert.equal(nv.data.lines, 6);
    ok(A.call(tok.admin, 'rc.activateVersion', { partnerId: 'PT-AA', version: 'v2.0' }));
    const r = create({}); ok(r, 'capture still prices on v1 until v2 takes effect');
    assert.equal(r.data.patientPrice, 1200);
  });
  it('duplicate reviews and dispute dismissal', () => {
    const d = A.call(tok.admin, 'dup.list', {}); ok(d); const pending = d.data.find(x => /Pending/.test(x.ResolutionStatus)); assert.ok(pending);
    fails(A.call(tok.admin, 'dup.resolve', { reviewId: pending.ReviewID, action: 'cancel', note: '' }), /note is mandatory/);
    ok(A.call(tok.admin, 'dup.resolve', { reviewId: pending.ReviewID, action: 'cancel', note: 'same patient, same tests' }));
    assert.equal(status(L.dup), 'Cancelled'); assert.equal(A.rows('Leads').find(x => x.LeadID === L.dup).RevenueState, 'Void');
  });
  it('audit log is append-only, filterable and readable only by the Admin', () => {
    const a = A.call(tok.admin, 'audit.list', { leadId: L.main }); ok(a); assert.ok(a.data.rows.length > 5);
    assert.ok(a.data.rows.every(r => r.LeadID === L.main));
    fails(A.call(tok.pcA, 'audit.list', {}), /not permitted/);
    const ids = A.rows('Audit').map(r => r.AuditID); assert.equal(new Set(ids).size, ids.length, 'audit IDs must be unique');
  });
  it('exports: Admin only, audited, and never the Users tab', () => {
    const e = A.call(tok.admin, 'export.table', { table: 'Leads' }); ok(e);
    assert.match(e.data.fileName, /^DCP_Leads_\d{8}_\d{4}\.csv$/); assert.ok(e.data.csv.split('\n')[0].includes('LeadID')); assert.ok(e.data.csv.includes(L.main));
    fails(A.call(tok.admin, 'export.table', { table: 'Users' }), /can't be exported/);
    fails(A.call(tok.pcA, 'export.table', { table: 'Leads' }), /not permitted/);
    assert.ok(A.rows('Audit').some(a => a.Action === 'EXPORT'));
  });
  it('config.view reports folders, triggers and the webhook URL', () => {
    const c = A.call(tok.admin, 'config.view', {}); ok(c);
    assert.equal(c.data.triggers.length, 4); assert.match(c.data.webhookUrl, /\?hook=msg&key=[0-9a-f]{32}$/); assert.ok(c.data.reportsFolder);
  });
});

describe('10 · privacy (DPDP)', () => {
  it('erasure scrubs identifiers everywhere but keeps amounts and IDs, and logs only the last 4 digits', () => {
    const phone = A.rows('Leads').find(x => x.LeadID === L.main).Phone;
    fails(A.call(tok.pcA, 'privacy.erasePatient', { phone: phone }), /not permitted/);
    fails(A.call(tok.admin, 'privacy.erasePatient', { phone: '9000000999' }), /No leads found/);
    const open = A.call(tok.admin, 'privacy.erasePatient', { phone: A.rows('Leads').find(x => x.LeadID === L.late).Phone });
    fails(open, /still in progress/); assert.equal(open.code, 'ERASE_OPEN_LEADS');
    const r = A.call(tok.admin, 'privacy.erasePatient', { phone: phone }); ok(r);
    const row = A.rows('Leads').find(x => x.LeadID === L.main);
    assert.equal(row.PatientName, '[redacted]'); assert.equal(row.Phone, ''); assert.equal(row.CollectionAddress, '');
    assert.equal(Number(row.ExpectedPatientPrice), 1200); assert.equal(row.ClosedAt !== '', true);
    const au = A.rows('Audit').find(a => a.Action === 'PII_ERASED');
    assert.doesNotMatch(JSON.stringify(au), new RegExp(phone)); assert.match(au.AfterJSON, /••••••0011/);
  });
  it('retention scrub does nothing while disabled and respects the cutoff when enabled', () => {
    assert.deepEqual(A.fn('purgePii_'), { enabled: false, purged: 0 });
    A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'PII_RETENTION_ENABLED', Value: 'TRUE' }, note: 'test' });
    const none = A.fn('purgePii_'); assert.equal(none.enabled, true); assert.equal(none.purged, 0, 'recently closed leads must survive');
    A.advanceHours(24 * 365 * 3);
    let some; try { some = A.fn('purgePii_'); } finally { A.advanceHours(-24 * 365 * 3); }
    assert.ok(some.purged >= 1, 'leads closed more than 24 months ago are scrubbed');
    A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'PII_RETENTION_ENABLED', Value: 'FALSE' }, note: 'restore' });
  });
});

describe('11 · messaging and the inbound webhook', () => {
  it('logging a click-to-WhatsApp send is recorded; opt-out blocks non-essential templates', () => {
    ok(A.call(tok.pcA, 'msg.log', { leadId: L.late, code: 'M1' }));
    assert.equal(A.rows('Messages').filter(m => m.LeadID === L.late && m.TemplateCode === 'M1').length, 1);
    ok(A.call(tok.pcA, 'lead.optout', { leadId: L.late, optOut: true }));
    fails(A.call(tok.pcA, 'msg.log', { leadId: L.late, code: 'M9' }), /opted out/);
    ok(A.call(tok.pcA, 'msg.log', { leadId: L.late, code: 'M8' }));
    ok(A.call(tok.pcA, 'lead.optout', { leadId: L.late, optOut: false }));
  });
  it('M9 rating is recorded after the report and feeds the CSAT KPI', () => {
    fails(A.call(tok.pcA, 'msg.rating', { leadId: L.edit, rating: 5 }), /after the report/);
    fails(A.call(tok.pcA, 'msg.rating', { leadId: L.late, rating: 9 }), /1–5/);
    ok(A.call(tok.pcA, 'msg.rating', { leadId: L.late, rating: 5 }));
    const k = A.call(tok.admin, 'dash.summary', {}).data.kpis.find(x => x.key === 'csat'); assert.equal(k.value, 100);
  });
  it('webhook: rejects a wrong key, applies STOP, records a numeric rating, updates receipts', () => {
    const key = A.ev('PropertiesService.getScriptProperties().getProperty("MSG_WEBHOOK_KEY")');
    const hook = (k, body) => JSON.parse(A.fn('doPost', [{ parameter: { hook: 'msg', key: k }, postData: { contents: JSON.stringify(body) } }]).content);
    assert.equal(hook('wrong', { phone: '9000000011', text: 'STOP' }).error, 'unauthorised');
    assert.equal(JSON.parse(A.fn('doPost', [{ parameter: {} }]).content).ok, false);
    const phone = A.rows('Leads').find(x => x.LeadID === L.late).Phone;
    const stop = hook(key, { phone: phone, text: 'stop' }); assert.equal(stop.ok, true); assert.ok(stop.actions.some(a => a.startsWith('optout:')));
    assert.equal(String(A.rows('Leads').find(x => x.LeadID === L.late).OptOut).toUpperCase(), 'TRUE');
    const mid = A.rows('Messages')[0].MsgID;
    assert.deepEqual(hook(key, { msgId: mid, status: 'delivered' }).actions, ['receipt:' + mid]);
    assert.ok(A.rows('Messages').find(m => m.MsgID === mid).DeliveredAt);
  });
});

describe('12 · scheduled jobs', () => {
  it('dailyDigest flags an SLA breach and emails coordinators their own queue', () => {
    signIn();
    const r = create({}); ok(r); const id = r.data.leadId;
    A.advanceHours(30); A.clearMail();
    let m;
    try { A.fn('dailyDigest'); m = A.mail(); } finally { A.advanceHours(-30); }
    const admin = m.find(x => /owner@example\.test/.test(x.to)); assert.ok(admin, 'admin digest sent'); assert.match(admin.subject, /Daily SLA digest · [1-9]\d* breached/);
    assert.ok(admin.htmlBody.includes(id));
    const pc = m.find(x => /pc\.aa@/.test(x.to)); assert.ok(pc, 'coordinator digest sent'); assert.match(pc.subject, /Your queue today/);
    assert.ok(!m.some(x => /pc\.bb@/.test(x.to) && x.htmlBody.includes(id)), 'another partner’s lead must not appear');
  });
  it('eveningReminders asks the coordinator to send M4 for tomorrow’s appointments', () => {
    signIn(); A.clearMail();
    const r = create({}); ok(r); advance(r.data.leadId, 'scheduled');
    A.fn('eveningReminders');
    const m = A.mail().find(x => /pc\.aa@/.test(x.to) && /appointment reminder/.test(x.subject)); assert.ok(m, 'reminder sent'); assert.match(m.subject, /appointment reminder.*M4/);
    assert.ok(m.htmlBody.includes(r.data.leadId));
  });
  it('weeklySummary renders without error and goes to the Admin', () => {
    A.clearMail(); A.fn('weeklySummary');
    const m = A.mail().find(x => /owner@/.test(x.to)); assert.ok(m); assert.match(m.subject, /Weekly management summary/);
    assert.doesNotMatch(m.htmlBody, /undefined|NaN|\[object/);
  });
  it('weeklyBackup copies the workbook, keeps only BACKUP_RETAIN_COUNT, and runs the retention scrub last', () => {
    for (let i = 0; i < 14; i++) { A.advanceHours(1 / 60); A.fn('weeklyBackup'); }
    const live = A.ev('(function(){ const f = rootFolder_("BACKUPS_FOLDER_ID","DCP Backups"); const it = f.getFiles(); let n = 0; while (it.hasNext()) { it.next(); n++; } return n; })()');
    assert.equal(live, 12);
  });
  it('an API-mode send that fails records the failure and falls back to SMS', () => {
    A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'MSG_MODE', Value: 'API' }, note: 'test' });
    A.ev('PropertiesService.getScriptProperties().setProperty("MSG_API_URL","https://api.example.test/send")');
    A.ev('__gas.fetchResponder = () => ({ code: 500, body: "boom" })');
    const r = create({}); ok(r, 'capture must still succeed when the messaging provider is down');
    const msgs = A.rows('Messages').filter(m => m.LeadID === r.data.leadId);
    assert.equal(msgs.length, 2); assert.equal(msgs[0].Status, 'failed'); assert.match(msgs[0].ErrorNote, /HTTP 500/);
    assert.equal(msgs[1].Channel, 'SMS'); assert.match(msgs[1].ErrorNote, /SMS fallback skipped/);
    A.call(tok.admin, 'md.save', { table: 'Config', row: { Key: 'MSG_MODE', Value: 'MANUAL' }, note: 'restore' });
  });
});

describe('13 · data hygiene', () => {
  // buildLines_ stamps RateCardID / RateCardVersion on every LeadTests line, but that tab has no such columns, so
  // rowArray() discards them. Nothing reads them back (prices are frozen on the line; later additions are priced from
  // Leads.CreatedAt), so it is harmless — listed here so it is a decision rather than an accident. Any OTHER field
  // that is written without a column fails this test.
  const KNOWN = { LeadTests: ['RateCardID', 'RateCardVersion'] };
  it('no write carries a field that has no column (it would be silently discarded)', () => {
    const d = A.dropped(), unexpected = {};
    for (const tab of Object.keys(d)) for (const col of Object.keys(d[tab])) if (!(KNOWN[tab] || []).includes(col)) (unexpected[tab] = unexpected[tab] || []).push(col);
    assert.deepEqual(unexpected, {}, 'fields written to a tab with no matching column — the data is lost on every write');
  });
  it('the only known drop is still the documented one', () => {
    assert.deepEqual(A.dropped(), { LeadTests: { RateCardID: A.dropped().LeadTests.RateCardID, RateCardVersion: A.dropped().LeadTests.RateCardVersion } });
  });
});
