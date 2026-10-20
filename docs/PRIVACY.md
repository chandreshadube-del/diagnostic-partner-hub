# Why the seed workbook is not in this repository

`DCP_App_Master_Seed_v1.xlsx` was supplied with the v3.0.3 source, and it is
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

## If seed data is needed in the repo

Two options, in order of preference:

1. **Synthesise it.** Generate fixture rows that match the schema in
   `docs/DATA_MODEL.md` with fake names and numbers. Good enough for tests and
   demos, and safe in public.
2. **Make the repository private first**, then commit only the tabs that are
   actually needed. Even then, `Users.PasswordHash` should be stripped and the
   affected passwords rotated, since a hash in git history outlives any later
   deletion.

Note that `.gitignore` blocks `*.xlsx` and `*.csv` as a backstop. Removing
those lines is a decision about patient data, not a housekeeping change.
