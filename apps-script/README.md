# DCP Apps Script project

The server for Project DCP v3.0.3 — Gynoveda's diagnostic centre partnership
app. Google Apps Script bound to a 22-tab Google Sheet, with report PDFs and
weekly backups in Drive. No external stack.

| File | What it is |
| --- | --- |
| `Code.gs` | the whole server — 4,127 lines, auth through settlement |
| `appsscript.json` | manifest: IST, V8, web app executing as the deployer, open to anyone |

`Index.html` is not in this repository yet; the deployment serves it from the
Apps Script project.

## Current state of the live project

Verified against the bound Google Sheet on 2026-10-20:

- `setup()` has been run — `Leads` carries the appended `StatusChangedAt` and
  `NextScanDate` columns, and all 14 of `NEW_CONFIG_ROWS` are present in `Config`
- the web app is **deployed**: the `APP_URL` row of `Config` holds a live
  `/exec` URL (not reproduced here — the manifest sets `ANYONE_ANONYMOUS`
  access, so that URL is a publicly reachable entry point to an app holding
  patient data, and it does not belong in a public repository)
- `MSG_MODE` is `MANUAL`, so no WhatsApp API credentials are in play yet
- `PII_RETENTION_ENABLED` is `FALSE` — nothing is being scrubbed on a default
- the `Audit` tab has a real trail, so the app has been exercised
- `Reports`, `Messages`, `Transfers` and `Allocations` are still empty: no
  report has been uploaded, no message logged, and the settlement chain has not
  yet been run end to end

## What `Code.gs` covers

Roughly in file order:

- **Auth** — app-managed logins, PBKDF2-HMAC-SHA256 salted hashes, admin-issued
  temporary passwords, forced first change, lockout, cached sessions
- **Leads** — capture with duplicate detection in a 30-day window, partner
  routing, and a rate freeze that prices a lead against the rate card active on
  the day it was captured
- **Workflow** — the 40-entry transition matrix in `TRANSITIONS`, gated per role
  by `roleCodeAllows_`, with lab selection that refuses a lab belonging to
  another partner, not Active, or unable to perform every test on the lead
- **Reports** — PDF upload validated by `%PDF` header and EOF marker, size
  capped by `MAX_REPORT_PDF_MB`, patient names kept out of stored filenames
- **Messaging** — the M-code templates, MANUAL mode as click-to-WhatsApp links,
  API mode with DLT SMS fallback, and an inbound delivery webhook
- **Settlement** — statement generation, partner confirmation and line
  disputes, bank transfers with duplicate-UTR refusal, FIFO allocation to the
  paisa, then close-eligible
- **Admin** — users, master data, rate card versioning, partner and lab
  activation, duplicates, disputes, audit, config
- **Privacy** — `erasePatient_` for DPDP requests and `purgePii_` for optional
  retention scrubbing, both of which keep IDs, dates and amounts so commission
  figures survive
- **Scheduled** — `dailyDigest` 09:00, `eveningReminders` 18:00,
  `weeklySummary` Monday 08:00, `weeklyBackup` Sunday 02:00, all IST

The audit tab is append-only; the app never edits or deletes an audit row.

## Deploying

1. Import `DCP_App_Master_Seed_v1.xlsx` into Google Sheets. All 22 tabs must be
   present or `setup()` refuses to run.
2. In that sheet: Extensions → Apps Script. Paste `Code.gs` and `Index.html`,
   and put `appsscript.json` in place (Project Settings → show manifest).
3. Run `setup()` once. It stores `SPREADSHEET_ID`, sets the timezone to IST,
   appends the `StatusChangedAt` and `NextScanDate` columns to `Leads`, adds the
   newer `Config` keys, and installs the four time triggers.
4. Deploy → New deployment → Web app, executing as yourself, access Anyone.
5. Paste the `/exec` URL into the `APP_URL` row of the `Config` tab — emails,
   temporary-password messages and the webhook URL all read it from there.

### Script properties

`setup()` writes `SPREADSHEET_ID`. Set the rest by hand only if you need them:

| Property | Needed for |
| --- | --- |
| `MSG_API_URL`, `MSG_API_TOKEN` | WhatsApp sending in API mode |
| `MSG_SMS_API_URL`, `MSG_SMS_API_TOKEN` | DLT SMS fallback |
| `MSG_WEBHOOK_KEY` | authenticating inbound delivery receipts |
| `REPORTS_FOLDER_ID`, `BACKUPS_FOLDER_ID` | reusing existing Drive folders instead of letting the app create them |

Keep every one of these in Script Properties. None belongs in `Code.gs`.

## Changing behaviour without touching code

Most thresholds are rows in the `Config` tab, with `CONFIG_DEFAULTS` in
`Code.gs` as the fallback when a key is missing: SLA hours, reminder days,
reopen and duplicate windows, PDF size cap, `MSG_MODE`, password policy, PBKDF2
iterations, KPI targets, and the two PII retention keys.
