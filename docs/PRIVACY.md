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

## Known gap: prescription photos survive an erasure

v3.0.13 stores a photo of the prescription pad per lead in Drive (`DCP Prescriptions/<clinic>/<yyyy-MM>/<LeadID>.jpg`),
referenced by `Leads.RxFileID` / `RxFileName`. The DPDP erase (`erasePatient_`) and the retention scrub (`purgePii_`)
redact the name, spouse name, phone and collection address on the lead row, but do not touch those fields or the file.

Verified end to end: after an erasure the name reads `[redacted]` while `lead.getPrescription` still returns the
image. The code takes the same position for report PDFs — clinical records are "a separate decision" — but a
prescription pad normally shows the patient's name, so an erased patient can remain identifiable from it.

Not changed here, because trashing Drive files is destructive and the retention policy is the owner's call. If you
decide photos should go with the erasure, the change is small: in `scrubLeadsPii_` (`60_admin.gs`) trash the file
and clear the three `Rx*` fields.
