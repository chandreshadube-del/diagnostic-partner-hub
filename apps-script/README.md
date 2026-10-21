# DCP Apps Script project

Server and web client for Project DCP **v3.0.13** — Gynoveda's diagnostic centre partnership app.
Google Apps Script bound to a 22-tab Google Sheet, with report PDFs, prescription photos and weekly
backups in Drive. No external services or libraries; the client loads nothing from the network.

## Files

| File | What it holds |
| --- | --- |
| `00_core.gs` | constants (statuses, the 40-entry transition matrix, Config defaults), helpers, the sheet access layer (`DB`), config, sequential IDs, audit buffer, mail |
| `10_auth.gs` | PBKDF2-HMAC-SHA256 hashing, cached sessions, role/scope resolution, login, password change and reset |
| `20_leads.gs` | rate cards and catalogue, routing, validation, package explosion, duplicate detection, lead capture, SLA timers, queue and search |
| `30_workflow.gs` | the status transitions and their guards, scheduling and lab selection, multi-visit scan progress, test edits and re-pricing, payment, re-route, lead detail |
| `40_reports_messages.gs` | report PDF upload and validation, prescription photos, WhatsApp templates (MANUAL and API modes, SMS fallback), reminders, inbound webhook |
| `50_settlement.gs` | statements, partner review and line disputes, transfers, FIFO allocation, closure |
| `60_admin.gs` | users, master data, partner and lab validation and activation, rate-card versions, duplicates, audit reader, exports, DPDP retention and erasure |
| `70_dashboard.gs` | KPIs, funnel, scorecards, month-over-month table |
| `80_triggers_setup.gs` | the four scheduled jobs and `setup()` |
| `90_api.gs` | `doGet`, `doPost`, the 65-action `ACTIONS` table, the `api()` dispatcher, `bootstrap_` |
| `Index.html` | the single-page client |
| `appsscript.json` | manifest: IST, V8, web app executing as the deployer, open to anyone |

**Load order matters.** Apps Script puts every `.gs` file in one global scope, and later files read
constants from earlier ones the moment they load (`90_api.gs` builds `[ROLE.ADMIN, …]` at top level).
Keep `00_core` first and the numeric prefixes in order. Out of order, every request fails with
`ReferenceError: ROLE is not defined`. The editor appends new files at the end, so check the order
after creating them by hand; `clasp push` sorts by filename, which is why the prefixes exist.

The old single-file `Code.gs` (v3.0.3) must **not** coexist with these — every `const` would be declared twice.

## Upgrading a live project

For a project already running v3.0.3 with the 53-column `Leads` tab:

1. In the Apps Script editor, delete `Code.gs`; add the ten `.gs` files above and `Index.html` (an HTML file named `Index`). Keep `appsscript.json`.
2. Run **`setup()`** once. It adds four `Leads` columns (`RxFileID`, `RxFileName`, `RxUploadedAt`, `VisitNumber` → 57 columns) and the `MAX_PRESCRIPTION_MB` Config row. Re-running it is safe: it reuses the Drive folders, replaces its own four triggers, and leaves the Admin's password alone once one has been issued.
3. **Deploy ▸ Manage deployments ▸ edit the existing deployment ▸ New version.** Do not use *New deployment* — that mints a new `/exec` URL, and the `APP_URL` Config row, the emailed links and the messaging webhook all point at the old one.

Until step 2, prescription photos are disabled and `VisitNumber` (which lead capture now requires) is accepted but not stored.

## Deploying a fresh project

1. Import `DCP_App_Master_Seed_v1.xlsx` into Google Sheets. All 22 tabs must exist or `setup()` refuses to run.
2. In that sheet: Extensions ▸ Apps Script. Create the files as above.
3. Run `setup()`. It stores `SPREADSHEET_ID`, sets the timezone, adds the build columns and Config rows, normalises ID/phone/date columns to plain text, removes the seed's example rows, creates the Drive folders and a webhook key, installs the triggers, and issues the Admin owner a temporary password.
4. Deploy ▸ New deployment ▸ Web app, execute as yourself, access Anyone. Paste the `/exec` URL into the `APP_URL` Config row.

The Admin's temporary password is shown once in the `setup()` log and emailed. To reset it later: **DCP App ▸ Issue Admin temporary password** in the sheet menu.

## Script properties

`setup()` writes `SPREADSHEET_ID`, `REPORTS_FOLDER_ID`, `BACKUPS_FOLDER_ID` and `MSG_WEBHOOK_KEY`. Set the rest by hand only if you need them:

| Property | Needed for |
| --- | --- |
| `MSG_API_URL`, `MSG_API_TOKEN` | WhatsApp sending in API mode |
| `MSG_SMS_API_URL`, `MSG_SMS_API_TOKEN` | DLT SMS fallback |
| `PRESCRIPTIONS_FOLDER_ID` | created on first prescription upload; set it to reuse an existing folder |

Keep every credential in Script Properties. None belongs in the source.

Most thresholds are rows in the `Config` tab, with `CONFIG_DEFAULTS` in `00_core.gs` as the fallback when a key is missing: SLA hours, reminder days, reopen and duplicate windows, PDF and photo size caps, `MSG_MODE`, password policy, PBKDF2 iterations, KPI targets, PII retention.

## Tests

```
npm test        # Node >= 20, no dependencies
```

`tests/` loads these exact `.gs` files, unmodified, into a Node `vm` against in-memory stand-ins for Sheets,
Drive, Cache, Lock, Mail and the rest (`tests/gas-mock.js`), then drives the real `api()` dispatcher as each role
over a **synthetic** workbook (`tests/fixtures/` — invented data, the real 22-tab structure). It covers auth and
lockout, lead capture and validation, every status branch, multi-visit scans, report uploads, settlement with FIFO
allocation, dashboards, DPDP erasure, the scheduled jobs and the webhook.

The mocks reproduce the Apps Script behaviours the code depends on, including signed bytes from
`Utilities.base64Decode`, Sheets coercing typed strings to dates and numbers unless a column is text-formatted,
a non-re-entrant script lock, and `setValues` rejecting a block of the wrong shape. They are not Google, so a pass
here is strong evidence, not a substitute for opening the deployed app once.

## Changes from the v3.0.13 files as received

Two defects found by the tests are fixed in this directory. If you maintain the project in the Apps Script
editor, paste in `80_triggers_setup.gs` and `70_dashboard.gs`. `APP_VERSION` is unchanged.

- **`80_triggers_setup.gs` — `setup()` no longer resets the Admin password on a re-run.** It issued a fresh temporary password to the owner every time it ran, but the app's own messages tell users to "run setup() again" to pick up new columns. The Audit tab on the live sheet records six passwords issued with the note `setup()` (from `setup()` itself or the menu item, which share it). It now issues one only if the Audit log has no earlier `setup()` password.
- **`70_dashboard.gs` — the month-over-month table read two columns that don't exist.** `Leads.PatientGender` and `Leads.PatientAmountRs`. *Male Test* was always 0 (every test counted as female) and *Gyno Margin %* was always blank. They now use `Gender` and `ExpectedPatientPrice`.

Not changed, for your decision: see the pull request description.
