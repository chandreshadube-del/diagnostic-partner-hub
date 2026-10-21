# Why the seed workbook is not in this repository

`DCP_App_Master_Seed_v1.xlsx` was supplied with the Apps Script source, and it is
deliberately left out of git. **This repository is public.**

The workbook as received on 2026-10-20 contains:

| Tab | What is in it |
| --- | --- |
| `Leads` | 1,190 rows of real patient data — name, mobile, age, gender, pincode, and for home collection the street address |
| `LeadTests` | 2,870 test lines keyed to those patients |
| `DuplicateReviews` | 69 rows repeating patient name and phone |
| `Users` | 37 staff rows with mobile numbers and PBKDF2-HMAC-SHA256 password hashes |
| `Labs`, `Clinics`, `Partners` | manager names, mobile numbers and email addresses across 286 rows |
| `RateCards`, `Statements`, `StatementLines`, `Transfers` | partner pricing, margins, payout totals and bank UTRs |

Publishing the patient rows would be a personal-data breach under the DPDP Act,
and the app itself is built to avoid exactly that — it hashes passwords, keeps
patient names out of stored report filenames, and ships a DPDP erase path
(`erasePatient_`) plus optional retention scrubbing (`purgePii_`).
Committing the source data here would undo all of it.

## Where the data lives instead

The system of record is the Google Sheet `DCP_App_Master_Seed_v1`, which the
Apps Script project reads through its `SPREADSHEET_ID` property. The uploaded
xlsx is a snapshot of it from before `setup()` ran. `DATA_MODEL.md` records the
live sheet's structure — tab names, column names and row counts — which is what
the code needs to be reviewable. No values are reproduced.

Two things from the sheet are also kept out of this repository on purpose: the
`APP_URL` deployment URL, because the manifest grants `ANYONE_ANONYMOUS` access
and so that URL is a live entry point to an app holding patient data, and
`ADMIN_OWNER_EMAIL`.

## Test data

`tests/fixtures/workbook.js` builds a **synthetic** workbook with the real 22-tab structure — invented names,
`example.test` addresses, `900000xxxx` mobiles — and `npm test` runs the whole server against it. That is the
safe route for fixtures in a public repository: it exercises every code path without a single production value.

If production rows are ever wanted in the repo, make it private first and strip `Users.PasswordHash` (rotating those
passwords, since a hash in git history outlives a later deletion). Note that `.gitignore` blocks `*.xlsx` and `*.csv`
as a backstop; removing those lines is a decision about patient data, not a housekeeping change.

## Prescription photos go with an erasure

v3.0.13 stores a photo of the prescription pad per lead in Drive (`DCP Prescriptions/<clinic>/<yyyy-MM>/<LeadID>.jpg`),
referenced by `Leads.RxFileID` / `RxFileName` / `RxUploadedAt`. A prescription pad normally shows the patient's name, so
both the on-demand DPDP erase (`erasePatient_`) and the scheduled retention scrub (`purgePii_`) now move the photo to the
Drive trash and clear those three fields along with the name, phone and address. Report PDFs are still left alone — the
code treats clinical records as a separate decision.

Behaviour worth knowing:

- **It is the Drive trash, not a hard delete.** Apps Script's `DriveApp` can only trash; Drive empties the trash after
  30 days. Until then the file is recoverable from the deploying user's trash. Empty it by hand if you need it gone sooner.
- **An erasure either completes or changes nothing.** If a photo exists but cannot be trashed, the erasure is refused
  with a message naming the lead, and the lead is not redacted. Retry; if it repeats, trash the file in Drive by hand.
  A file that is already gone from Drive does not block an erasure.
- **The retention scrub skips such a lead and retries it next week** rather than redact it and leave the photo behind.
  The skip is named in the audit entry.
- Leads erased *before* this change keep their photo reference. Nothing finds them again (the phone is gone), so trash
  those files from the Drive folder by hand if any exist.
- The scheduled scrub now takes the script lock, like every other write, and writes its own `PII_PURGED` audit entry.
  Before, a purge by the weekly job left no audit record at all.
