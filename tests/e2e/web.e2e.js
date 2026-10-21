/* Browser end-to-end check: the real Index.html in real Chromium, talking to the real server code (bridged in place of
 * google.script.run — see bridge.js), driven through a lead's whole life by each of the four roles.
 *
 *   npm run test:e2e        needs Playwright + its Chromium (PLAYWRIGHT_BROWSERS_PATH)
 *   E2E_SHOTS=/some/dir     where screenshots go (default: the OS temp dir)
 *
 * Data is the synthetic workbook; nothing here touches Google.
 */
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createApp, pdfB64 } = require('../harness');
const { PASSWORD } = require('../fixtures/workbook');
const { startBridge } = require('./bridge');

const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'dcp-e2e');
const NOW = '2026-10-21T10:00:00+05:30';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const T = { timeout: 90000 };

let A, bridge, browser, TEMP;
const problems = [];                       // anything unexpected the browser reported, across every page
const contexts = [];

/** A fresh browser profile (so no stored token leaks between roles), sitting on the login page. */
async function visit(label, opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  await context.clock.setFixedTime(new Date(NOW));          // the page's "today" must match the server's
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => problems.push(label + ' · uncaught: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(label + ' · console.error: ' + m.text()); });
  page.on('requestfailed', r => problems.push(label + ' · request failed: ' + r.url()));
  page.on('response', r => { if (r.status() >= 400) problems.push(label + ' · HTTP ' + r.status() + ' ' + r.url()); });
  contexts.push(context);
  await page.goto(bridge.url);
  await page.waitForSelector('#login-form');
  return page;
}
async function signIn(page, email, password) {
  await page.fill('#login-form [name=email]', email);
  await page.fill('#login-form [name=password]', password);
  await page.click('#login-form button[type=submit]');
}
async function login(label, email, password, opts) {
  const page = await visit(label, opts);
  await signIn(page, email, password || PASSWORD);
  await page.waitForSelector('.topbar'); await settle(page);
  return page;
}
async function settle(page) {                                // wait out the loading overlay and any chained renders
  await page.waitForTimeout(80);
  await page.waitForFunction(() => document.querySelector('#loading').classList.contains('hide'));
  await page.waitForTimeout(120);
}
const toast = (page, kind, re) => page.locator('#toast .toast.' + kind, { hasText: re }).first().waitFor({ timeout: 8000 });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const row = (tab, key, id) => A.rows(tab).find(r => r[key] === id);
async function openLead(page, id) {
  const sel = '[data-act=open-lead][data-id="' + id + '"]';
  if (!(await page.locator(sel).first().isVisible().catch(() => false))) {
    const all = page.locator('button[data-act=q-tab][data-tab=all]');
    if (await all.count()) { await all.click(); await settle(page); }
  }
  await page.locator(sel).first().click(); await settle(page);
  await page.waitForSelector('#lead-form', { state: 'attached' });
}
async function transition(page, to, fill) {
  await page.locator('button[data-act=t-open][data-to="' + to + '"]').click();
  await page.waitForSelector('#t-form');
  if (fill) await fill(page.locator('#t-form'));
  await page.locator('#t-form button[type=submit]').click(); await settle(page);
}
async function fillCapture(page, o) {
  await page.waitForSelector('#cap'); await settle(page);
  await page.fill('#cap [name=patientName]', o.name);
  await page.selectOption('#cap [name=gender]', o.gender || 'F');
  await page.fill('#cap [name=age]', String(o.age || 30));
  await page.fill('#cap-phone', o.phone);
  await page.fill('#cap [name=pincode]', o.pincode || '400001');
  await page.selectOption('#cap-doc', 'Dr. Asha');
  for (const code of o.tests) await page.check('.cap-pick[data-code="' + code + '"]');
  if (o.rx) await page.setInputFiles('#cap-rx', { name: 'rx.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await page.check('#cap [name=consent]');
}
/** After submitting the capture form: wait for the success screen itself, then read the new lead's id from its button. */
async function capturedId(page) {
  const btn = page.locator('#main [data-act=open-lead]').first();
  await btn.waitFor({ timeout: 8000 });
  return btn.getAttribute('data-id');
}
/** Click through every nav screen of the signed-in role; return screens that errored or rendered nothing. */
async function visitAllScreens(page) {
  const views = await page.locator('#nav button').evaluateAll(bs => bs.map(b => b.dataset.view));
  const bad = [];
  for (const v of views) {
    await page.click('#nav-' + v); await settle(page);
    const errs = await page.locator('#toast .toast.err').allInnerTexts();
    const text = (await page.locator('#main').innerText()).trim();
    const leak = text.match(/&(?:lt|gt|quot|amp|#39);|<\/?(?:td|th|tr|table|div|span|button|label|input|select|option|h\d)\b[^>]{0,40}/i);
    if (errs.length || text.length < 20 || leak) bad.push(v + (errs.length ? ' → ' + errs.join('; ') : leak ? ' → shows raw markup as text: "' + leak[0] + '"' : ' → rendered almost nothing'));
    await page.evaluate(() => { document.querySelector('#toast').innerHTML = ''; });
  }
  return { views, bad };
}

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  A = createApp();
  TEMP = A.fn('setup').match(/temporary password: (\S+)/)[1];   // the upgraded state the deployed app will be in
  bridge = await startBridge(A);
  browser = await chromium.launch({ headless: true });
});
after(async () => { for (const c of contexts) await c.close().catch(() => {}); if (browser) await browser.close(); if (bridge) await bridge.close(); });

describe('web app, end to end', () => {
  let L1, L2;

  it('serves the login page and rejects a bad password', T, async () => {
    const page = await visit('login');
    assert.equal(await page.title(), 'Gynoveda DCP');
    await signIn(page, 'cm.a@example.test', 'wrongpass1');
    await toast(page, 'err', /Invalid email or password/);
    assert.equal(await page.locator('.topbar').count(), 0, 'must stay on the login page');
    await shot(page, '01-login');
  });

  it('Admin: the first sign-in forces a new password, then lands on the dashboard', T, async () => {
    const page = await visit('admin-first');
    await signIn(page, 'owner@example.test', TEMP);
    await page.waitForSelector('#pw-form');
    await page.fill('#pw-form [name=newPassword]', PASSWORD); await page.fill('#pw-form [name=confirmPassword]', PASSWORD);
    await page.click('#pw-form button[type=submit]');
    await page.waitForSelector('.topbar'); await settle(page);
    assert.match(await page.locator('.who').innerText(), /Admin/);
    assert.ok(await page.locator('#nav-dashboard.on').count(), 'Admin lands on the Dashboard');
    await shot(page, '02-admin-dashboard-empty');
  });

  it('Admin: all 13 screens render on an empty database', T, async () => {
    const page = await login('admin-empty', 'owner@example.test');
    const { views, bad } = await visitAllScreens(page);
    assert.equal(views.length, 13);
    assert.deepEqual(bad, [], 'screens that errored or were blank');
  });

  it('Clinic Manager: captures a lead with a prescription photo', T, async () => {
    const page = await login('cm', 'cm.a@example.test');
    assert.deepEqual(await page.locator('#nav button').allInnerTexts().then(t => t.map(x => x.replace(/\d+$/, '').trim())), ['New lead', 'My leads', 'Reminders', 'Search']);
    await fillCapture(page, { name: 'Anita Test', phone: '9000000701', tests: ['TST-001', 'TST-002'], rx: true });
    assert.match(await page.locator('#cap-total').innerText(), /1,200/, 'running total shows the patient price');
    await shot(page, '03-capture-form');
    await page.click('#cap-submit');
    L1 = await capturedId(page);
    assert.equal(L1, 'GYN-261021-0001');
    const r = row('Leads', 'LeadID', L1);
    assert.equal(r.PatientName, 'Anita Test'); assert.equal(r.Status, 'Lead generated'); assert.equal(String(r.VisitNumber), '1');
    assert.ok(r.RxFileID, 'the prescription photo was stored'); assert.equal(Number(r.ExpectedPatientPrice), 1200);
    await shot(page, '04-capture-success');
  });

  it('Clinic Manager on a phone: the capture form fits a 390px screen with no sideways scroll', T, async () => {
    const page = await login('cm-phone', 'cm.a@example.test', PASSWORD, { viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#cap'); await settle(page);
    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    assert.ok(m.scroll <= m.view + 1, 'horizontal overflow: page is ' + m.scroll + 'px wide in a ' + m.view + 'px viewport');
    const btn = await page.locator('#cap-submit').boundingBox();
    assert.ok(btn && btn.x >= 0 && btn.x + btn.width <= m.view + 1, 'the submit button must be fully on screen');
    await shot(page, '05-capture-phone');
  });

  it('Clinic Manager: a duplicate phone is flagged before submit and can be confirmed', T, async () => {
    const page = await login('cm-dup', 'cm.a@example.test');
    await fillCapture(page, { name: 'Anita Test Again', phone: '9000000701', tests: ['TST-001', 'TST-002'] });
    await page.locator('#cap-phone').blur();
    await page.locator('#cap-dup', { hasText: /Possible duplicate/ }).waitFor({ timeout: 8000 });
    await shot(page, '06-duplicate-warning');
    await page.click('#cap-submit');
    await page.locator('#cf-ok').click();                                   // "This phone already has a lead… Submit anyway?"
    L2 = await capturedId(page);
    assert.notEqual(L2, L1); assert.ok(row('Leads', 'LeadID', L2), 'the acknowledged duplicate was saved as ' + L2);
    assert.equal(A.rows('DuplicateReviews').filter(d => d.DuplicateLeadID === L2).length, 1, 'filed for Admin review');
  });

  it('Partner Coordinator: logs the call, confirms the booking, schedules the lab visit', T, async () => {
    const page = await login('pc', 'pc.aa@example.test');
    assert.deepEqual(await page.locator('#nav button').allInnerTexts().then(t => t.map(x => x.replace(/\d+$/, '').trim())), ['Queues', 'Reminders', 'Search', 'Statements', 'Request lab']);
    await shot(page, '07-pc-queue');
    await openLead(page, L1);
    await transition(page, 'Called by lab', f => f.locator('[name=note]').fill('Patient confirmed she wants both tests'));
    await toast(page, 'ok', /Updated: Called by lab/);
    await transition(page, 'Test booked');
    await toast(page, 'ok', /Updated: Test booked/);
    await transition(page, 'Lab visit scheduled', async f => { await f.locator('select[name=labId]').selectOption('LB-AA-001'); await f.locator('[name=apptSlot]').fill('10:30'); });
    await toast(page, 'ok', /Updated: Lab visit scheduled/);
    const r = row('Leads', 'LeadID', L1);
    assert.equal(r.Status, 'Lab visit scheduled'); assert.equal(r.AssignedLabID, 'LB-AA-001'); assert.equal(r.ApptDate, '2026-10-22'); assert.equal(r.ApptSlot, '10:30');
    await shot(page, '08-pc-scheduled');
  });

  it('Lab user: sees only their lab’s lead, logs progress, marks the test done', T, async () => {
    const page = await login('lab', 'lab.aa@example.test');
    assert.deepEqual(await page.locator('#nav button').allInnerTexts().then(t => t.map(x => x.replace(/\d+$/, '').trim())), ['Lab queue', 'Search']);
    await page.locator('button[data-act=q-tab][data-tab=all]').click(); await settle(page);
    assert.equal(await page.locator('[data-act=open-lead]').count(), 1, 'only the one lead assigned to this lab');
    await openLead(page, L1);
    assert.equal(await page.locator('#main, #modal-root').filter({ hasText: /Margin|Gynoveda margin/ }).count(), 0, 'no commercial figures for the lab');
    await page.locator('button[data-act=f-open][data-form=progress]').click();
    await page.waitForSelector('#x-form');
    for (const c of await page.locator('#x-form input[name=line]').all()) await c.check();
    await page.locator('#x-form button[type=submit]').click(); await settle(page);
    await toast(page, 'ok', /All tests complete/);
    await transition(page, 'Test done');
    await toast(page, 'ok', /Updated: Test done/);
    const r = row('Leads', 'LeadID', L1);
    assert.equal(r.Status, 'Test done'); assert.equal(r.RevenueState, 'Earned');
    await shot(page, '09-lab-done');
  });

  it('Partner Coordinator: records the patient’s payment', T, async () => {
    const page = await login('pc-pay', 'pc.aa@example.test');
    await openLead(page, L1);
    await page.locator('button[data-act=f-open][data-form=payment]').click();
    await page.waitForSelector('#x-form');
    await page.locator('#x-form [name=paymentMode]').selectOption('UPI');
    await page.locator('#x-form button[type=submit]').click(); await settle(page);
    await toast(page, 'ok', /Payment recorded/);
    const r = row('Leads', 'LeadID', L1);
    assert.equal(r.PaymentMode, 'UPI'); assert.equal(Number(r.PaymentAmount), 1200);
  });

  it('Lab user: uploads the report PDF, which marks the report generated', T, async () => {
    const page = await login('lab-report', 'lab.aa@example.test');
    await openLead(page, L1);
    await page.locator('button[data-act=f-open][data-form=upload]').click();
    await page.waitForSelector('#x-form');
    await page.setInputFiles('#x-form input[type=file]', { name: 'Anita Test report.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfB64(), 'base64') });
    await page.locator('#x-form button[type=submit]').click(); await settle(page);
    await toast(page, 'ok', /marked report generated/);
    assert.equal(row('Leads', 'LeadID', L1).Status, 'Test report generated');
    const rep = row('Reports', 'LeadID', L1);
    assert.equal(rep.FileName, L1 + '-1.pdf', 'the patient’s name must not appear in the stored file name');
  });

  it('Admin: generates the statement, records the transfer (FIFO), and closes the lead', T, async () => {
    const page = await login('admin-settle', 'owner@example.test');
    await page.click('#nav-settlement'); await settle(page);
    await page.locator('#st-gen select[name=partnerId]').selectOption('PT-AA');
    await page.locator('#st-gen [name=month]').fill('2026-10');
    await page.locator('#st-gen button').click(); await settle(page);
    await toast(page, 'ok', /STMT-AA-202610: 1 lines added/);
    await page.locator('#st-trf select[name=partnerId]').selectOption('PT-AA');
    await page.locator('#st-trf [name=amountRs]').fill('400'); await page.locator('#st-trf [name=utr]').fill('UTR-E2E-0001');
    await page.locator('#st-trf button').click(); await settle(page);
    await toast(page, 'ok', /Allocated.*400.*1 lines collected/);
    assert.equal(row('Leads', 'LeadID', L1).RevenueState, 'Collected');
    await shot(page, '10-settlement');
    await page.locator('[data-act=st-close]').click(); await settle(page);
    await toast(page, 'ok', /1 lead\(s\) closed/);
    assert.equal(row('Leads', 'LeadID', L1).Status, 'Closed');
  });

  it('Admin: the month-over-month table is a real table with the right figures (including the margin % that used to be blank)', T, async () => {
    const page = await login('admin-dash', 'owner@example.test');
    await page.click('#nav-dashboard'); await settle(page);
    const table = page.locator('#dm-body table');
    assert.equal(await table.count(), 1, 'the comparison must render as a <table>, not as text');
    const cell = async label => (await table.locator('tr', { hasText: label }).first().locator('td').allInnerTexts()).map(x => x.trim());
    assert.ok((await table.locator('th').allInnerTexts()).some(h => /oct-26/i.test(h)), 'a column for the current month');
    const margin = await cell('Gyno Margin'), leads = await cell('leads'), male = await cell('Male test');
    assert.equal(margin[margin.length - 1], '33.3%', 'Gyno margin % — (400+400)/(1200+1200)');
    assert.equal(leads[leads.length - 1], '2'); assert.equal(male[male.length - 1], '0');
    assert.doesNotMatch(await page.locator('#main').innerText(), /undefined|NaN|\[object|&lt;|&quot;/);
    await shot(page, '11-admin-dashboard');
  });

  it('every role can open every one of their screens once there is data', T, async () => {
    const results = {};
    for (const [label, email] of [['admin', 'owner@example.test'], ['cm', 'cm.a@example.test'], ['pc', 'pc.aa@example.test'], ['lab', 'lab.aa@example.test']]) {
      const page = await login('screens-' + label, email);
      const { views, bad } = await visitAllScreens(page);
      results[label] = { views: views.length, bad };
    }
    assert.deepEqual(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.bad])), { admin: [], cm: [], pc: [], lab: [] });
    assert.deepEqual(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.views])), { admin: 13, cm: 4, pc: 5, lab: 2 });
  });

  it('sign-out returns to the login page; an expired session sends the user back there with an explanation', T, async () => {
    const page = await login('session', 'owner@example.test');
    await page.locator('[data-act=logout]').click();
    await page.locator('#login-form').waitFor(); await page.locator('.alert', { hasText: /Signed out/ }).waitFor();
    await signIn(page, 'owner@example.test', PASSWORD); await page.waitForSelector('.topbar'); await settle(page);
    A.advanceHours(13);
    try { await page.click('#nav-queue'); await page.locator('#login-form').waitFor({ timeout: 8000 }); await page.locator('.alert', { hasText: /session has expired/i }).waitFor({ timeout: 8000 }); }
    finally { A.advanceHours(-13); }
  });

  it('nothing went wrong behind the scenes: no console errors, no failed requests, and every refused server call was expected', T, async () => {
    const refused = bridge.calls.filter(c => !c.ok).map(c => c.action + ': ' + (c.code || c.error));
    const expected = c => /^auth\.login: Invalid email or password/.test(c) || /^lead\.create: DUPLICATE_WARNING/.test(c) || /SESSION_EXPIRED/.test(c);
    const unexpected = refused.filter(c => !expected(c));
    console.log('    server calls made by the browser: ' + bridge.calls.length + ' · refused: ' + refused.length + ' (' + [...new Set(refused)].join(' | ') + ')');
    assert.deepEqual(problems, [], 'browser-side problems');
    assert.deepEqual(unexpected, [], 'server calls the page made that the server refused unexpectedly');
  });
});
