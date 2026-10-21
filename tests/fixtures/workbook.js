/* Synthetic DCP workbook — the real 22-tab structure with invented data.
 * Nothing here is derived from production rows: names, numbers and addresses are fake
 * (example.test domains, 900000xxxx mobiles). Structure comes from headers.json, which is
 * the header row of the live sheet (Leads has the 53 columns it had before v3.0.13's setup()).
 */
'use strict';
const crypto = require('node:crypto');
const HEADERS = require('./headers.json');

const PASSWORD = 'Passw0rd1';
const hashPw = (pw, iter = 2000) => {            // independent PBKDF2 — cross-checks the app's hand-rolled one
  const salt = crypto.randomBytes(8);
  return 'p2$' + iter + '$' + salt.toString('hex') + '$' + crypto.pbkdf2Sync(pw, salt, iter, 32, 'sha256').toString('hex');
};

function build() {
  const T = {};                                             // tab -> array of row objects
  const add = (tab, o) => { (T[tab] = T[tab] || []).push(o); };

  [['ADMIN_OWNER_EMAIL', 'owner@example.test', 'Auth'], ['APP_URL', 'https://script.google.com/macros/s/EXAMPLE/exec', 'System'],
   ['MSG_MODE', 'MANUAL', 'Messaging'], ['SLA_CALL_HOURS', '24', 'SLA'], ['LATE_PAYMENT_INTEREST_MONTHLY_PCT', '1.5', 'Commercial'],
   ['PII_RETENTION_ENABLED', 'FALSE', 'Privacy']].forEach(([Key, Value, Category]) => add('Config', { Key, Value, Category, Description: '' }));

  add('Regions', { RegionID: 'RG-WEST', Name: 'West', Active: true }); add('Regions', { RegionID: 'RG-EAST', Name: 'East', Active: true });
  add('Areas', { AreaID: 'AR-MMR', RegionID: 'RG-WEST', Name: 'Mumbai', PilotScope: true, Active: true });
  add('Areas', { AreaID: 'AR-KOL', RegionID: 'RG-EAST', Name: 'Kolkata', PilotScope: true, Active: true });

  const clinic = (id, name, area, region, city, state, pin, partner, status) => add('Clinics', {
    ClinicID: id, Name: name, AreaID: area, RegionID: region, City: city, State: state, Address: name + ', Test Road', Pincode: pin,
    ClinicPhone: '9000000100', DefaultPartnerID: partner, ClinicManagerName: 'Clinic Mgr ' + id, ClinicManagerEmail: id.toLowerCase() + '@example.test',
    ReferringDoctors: 'Dr. Asha|Dr. Bina|Other — type name', Status: status });
  clinic('CL-AAA', 'Test Clinic A', 'AR-MMR', 'RG-WEST', 'Mumbai', 'Maharashtra', '400001', 'PT-AA', 'Active');
  clinic('CL-BBB', 'Test Clinic B', 'AR-KOL', 'RG-EAST', 'Kolkata', 'West Bengal', '700001', 'PT-BB', 'Active');
  clinic('CL-CCC', 'Test Clinic C', 'AR-MMR', 'RG-WEST', 'Mumbai', 'Maharashtra', '400002', 'PT-AA', 'Paused');

  const partner = (id, legal, disp, state, n) => add('Partners', {
    PartnerID: id, LegalName: legal, DisplayName: disp, Type: 'Aggregator', State: state, AgreementRef: 'AGR-' + id, AgreementDate: { $d: '2026-01-01' },
    EffectiveDate: { $d: '2026-01-01' }, ValidityMonths: 12, PrimaryContactName: 'Primary ' + id, PrimaryContactMobile: 9000000200 + n,
    PrimaryContactEmail: 'primary.' + id.toLowerCase() + '@example.test', EscalationContactName: 'Escalation ' + id, EscalationContactMobile: 9000000300 + n,
    EscalationContactEmail: 'esc.' + id.toLowerCase() + '@example.test', CallingNumber: '9000000400', ReportSharingMethod: 'App', CommissionRule: 'Margin', SettlementCycle: 'Monthly' });
  partner('PT-AA', 'Alpha Diagnostics Pvt Ltd', 'Alpha Diagnostics', 'Active', 1);
  partner('PT-BB', 'Beta Labs Pvt Ltd', 'Beta Labs', 'Active', 2);
  partner('PT-CC', 'Gamma Path Pvt Ltd', 'Gamma Path', 'Draft', 3);

  const lab = (id, partnerId, name, clinics, addr, pin, modes, tests, state, n) => add('Labs', {
    LabID: id, PartnerID: partnerId, LabName: name, ClinicIDServed: clinics, AreaName: 'Test', Address: addr, Pincode: pin,
    MapsLink: 'https://maps.example.test/' + id, LabPhone: '02200000' + String(n).padStart(3, '0'), LabManagerName: 'Manager ' + id,
    LabManagerMobile: 9000000500 + n, LabManagerEmail: id.toLowerCase() + '@example.test', Modes: modes,
    HomeCollectionPincodes: modes === 'Lab visit' ? '' : '400001,400002', TestsPerformed: tests, NABLCertNumber: 'NABL-' + id, State: state });
  lab('LB-AA-001', 'PT-AA', 'Alpha Central Lab', 'CL-AAA', 'Plot 1, Test Road, Mumbai', '400001', 'Both', 'ALL', 'Active', 1);
  lab('LB-AA-002', 'PT-AA', 'Alpha Pathology Annex', 'CL-AAA', 'Plot 2, Test Road, Mumbai', '400003', 'Lab visit', 'ALL_PATHOLOGY', 'Active', 2);
  lab('LB-BB-001', 'PT-BB', 'Beta Main Lab', 'CL-BBB', 'Plot 9, Sample Street, Kolkata', '700001', 'Both', 'ALL', 'Active', 3);
  lab('LB-CC-001', 'PT-CC', 'Gamma Lab', 'CL-AAA', 'Plot 7, Draft Lane, Mumbai', '400004', 'Lab visit', 'ALL', 'Draft', 4);

  const test = (code, name, cat, gender, male, scans, tat, home) => add('Tests', { TestCode: code, Name: name, Category: cat, GenderApplicability: gender,
    MaleOnly: male, ScansRequired: scans, DefaultTATHours: tat, HomeCollectionAllowed: home, PreparationNotes: code === 'TST-001' ? 'No fasting needed' : '', Active: true });
  test('TST-001', 'CBC', 'Pathology', 'F/M', false, 1, 24, true);
  test('TST-002', 'AMH', 'Pathology', 'F', false, 1, 48, true);
  test('TST-003', 'USG Pelvis', 'Imaging', 'F', false, 1, 24, false);
  test('TST-004', 'Follicular Study', 'Imaging', 'F', false, 3, 48, false);
  test('TST-005', 'Semen Analysis', 'Pathology', 'M', true, 1, 48, true);
  add('Packages', { PackageCode: 'PKG-01', Name: 'Fertility Basic', FemaleTests: 'CBC, AMH', FemaleTestCodes: 'TST-001,TST-002', MaleTests: 'Semen Analysis',
    MaleTestCodes: 'TST-005', TotalComponentTests: 3, IncludesScans: false, ActiveInPilot: true });

  // Rate cards: [code, type, name, mrp, price, margin, tat, home]
  const items = [['TST-001', 'SingleTest', 'CBC', 400, 300, 100, 24, true], ['TST-002', 'SingleTest', 'AMH', 1200, 900, 300, 48, true],
    ['TST-003', 'SingleTest', 'USG Pelvis', 1000, 700, 200, 24, false], ['TST-004', 'SingleTest', 'Follicular Study', 3000, 2100, 600, 48, false],
    ['TST-005', 'SingleTest', 'Semen Analysis', 600, 450, 150, 48, true], ['PKG-01', 'Package', 'Fertility Basic', 2000, 1400, 400, 72, true]];
  const rate = (pid, short, state, subset) => items.filter(i => !subset || subset.includes(i[0])).forEach((i, n) => add('RateCards', {
    RateCardID: 'RC-' + short + '-v1-' + String(n + 1).padStart(3, '0'), PartnerID: pid, Version: 'v1', ItemType: i[1], ItemCode: i[0], ItemName: i[2],
    MRP: i[3], PatientPrice: i[4], GynovedaMarginRs: i[5], PartnerB2BShareRs: i[4] - i[5], MarginPctOfMRP: i[5] / i[3], ContractualMarginRs: i[5],
    TATHours: i[6], HomeCollectionAllowed: i[7], VisibleToClinics: true, EffectiveFrom: { $d: '2026-01-01' }, State: state }));
  rate('PT-AA', 'AA', 'Active'); rate('PT-BB', 'BB', 'Active'); rate('PT-CC', 'CC', 'Draft', ['TST-001', 'TST-002']);

  const user = (id, email, name, role, orgType, orgId, scopeType, scopeIds, n) => add('Users', { UserID: id, Email: email, Name: name, Mobile: 9000000600 + n,
    Role: role, OrgType: orgType, OrgID: orgId, ScopeType: scopeType, ScopeIDs: scopeIds, PasswordHash: hashPw(PASSWORD), FailedAttempts: 0, ForcePasswordChange: false, Active: true });
  user('USR-ADM-01', 'owner@example.test', 'Owner Admin', 'Admin', 'Gynoveda', 'HQ', 'ALL', 'ALL', 1);
  user('USR-CM-A', 'cm.a@example.test', 'Clinic Mgr A', 'Clinic Manager', 'Clinic', 'CL-AAA', 'CLINIC', 'CL-AAA', 2);
  user('USR-CM-B', 'cm.b@example.test', 'Clinic Mgr B', 'Clinic Manager', 'Clinic', 'CL-BBB', 'CLINIC', 'CL-BBB', 3);
  user('USR-PC-AA', 'pc.aa@example.test', 'Coordinator Alpha', 'Partner Coordinator', 'Partner', 'PT-AA', 'REGION', 'RG-WEST', 4);
  user('USR-PC-BB', 'pc.bb@example.test', 'Coordinator Beta', 'Partner Coordinator', 'Partner', 'PT-BB', 'REGION', 'RG-EAST', 5);
  user('USR-LU-AA', 'lab.aa@example.test', 'Lab User Alpha', 'Lab User', 'Lab', 'LB-AA-001', 'LAB', 'LB-AA-001', 6);
  user('USR-LU-BB', 'lab.bb@example.test', 'Lab User Beta', 'Lab User', 'Lab', 'LB-BB-001', 'LAB', 'LB-BB-001', 7);

  [['M1', 'Welcome', 'Lead generated', 'Hello {PatientName}, {ClinicName} has referred you for {TestList}. {PartnerName} will call from {PartnerCallingNumber}.'],
   ['M2', 'Lab visit booked', 'Lab visit scheduled', 'Hi {PatientName}: {TestList} at {LabName}, {LabAddress} on {ApptDate} {ApptTime}. {PrepNotes}'],
   ['M3', 'Home collection booked', 'Home collection', 'Hi {PatientName}: home sample collection on {ApptDate} {ApptTime} at {CollectionAddress}. {PrepNotes}'],
   ['M4', 'Appointment tomorrow', 'Evening before', 'Reminder {PatientName}: {TestList} tomorrow {ApptTime} at {LabName}.'],
   ['M5', 'Next scan due', 'Scan logged', 'Hi {PatientName}: scan {ScanNum} done; next scan on {NextScanDate} at {LabName}.'],
   ['M6', 'Rescheduled', 'Rescheduled', 'Hi {PatientName}: your appointment moved to {ApptDate} {ApptTime} at {LabName}.'],
   ['M7', 'Follow-up', 'Follow-up date', 'Hi {PatientName}, shall we book your {TestList} now? Call {PartnerCallingNumber}.'],
   ['M8', 'Report ready', 'Report generated', 'Hi {PatientName}, your report for {TestList} is ready. Please share it with Dr. {DoctorName}.'],
   ['M9', 'Survey', 'Survey', 'Hi {PatientName}, rate your experience 1-5.'],
   ['M-REM', 'Pending test', 'Pending', 'Hi {PatientName}, pending: {PendingTestList}.']]
    .forEach(([TemplateCode, Name, TriggerEvent, BodyText]) => add('Templates', { TemplateCode, Name, TriggerEvent, Channel: 'WhatsApp', BodyText, VariablesUsed: '', WhatsAppTemplateID: 'WA-' + TemplateCode, SMSTemplateID: '', Active: true }));

  const sheets = Object.keys(HEADERS).map(name => ({
    name, headers: HEADERS[name],
    rows: (T[name] || []).map(o => HEADERS[name].map(h => (o[h] === undefined ? '' : o[h]))),
    maxCols: Math.max(26, HEADERS[name].length)
  }));
  return { id: 'SYNTHETIC-WORKBOOK', sheets };
}

module.exports = { build, PASSWORD, HEADERS };
