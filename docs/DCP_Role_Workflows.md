Gynoveda DCP · v3.0.3

# Who does what, and when

Four roles move a diagnostic lead from a clinic desk to a settled commission. Every step below is taken from the app's own transition matrix and permission map — these are the moves the server actually allows, not a description of intent.

Clinic Manager

one clinic · 12 seats

**16**actions

**1**status move

Partner Coordinator

one partner · 12 seats

**22**actions

**27**status moves

Lab User

one lab · 12 seats

**9**actions

**4**status moves

Admin

everything · 1 seat

**58**actions

**40**status moves

The main path

## One lead, eight stages, three handoffs

A lead changes hands twice on the way out and once on the way back. The SLA clock starts the moment a stage is entered; the message codes are the WhatsApp templates that fire at that moment in MANUAL mode.

01

Lead generatedClinic Manager

Captures patient, gender, age, mobile, pincode and the tests, against the clinic's routed partner and its active rate card. Prices freeze onto the lead at this moment.

M1 welcome duplicate check · 30 days consent required

02

Called by labPartner Coordinator

First handoff. The coordinator calls the patient and must enter a call summary — the move is refused without one. Unreachable patients branch off here with a retry time.

SLA 24h · warn 2h · priority 4h note ≥ 3 chars

03

Test bookedPartner Coordinator

Patient has agreed. Tests can still be added or removed here — additions are priced on the rate card the lead was captured against, never today's.

SLA 48h

04

Lab visit scheduled or Home sample collectionPartner Coordinator

Picks the fulfilling lab, date and slot. The app refuses a lab that belongs to another partner, is not Active, or does not perform every test on the lead. Home collection additionally checks the pincode and blocks imaging.

SLA 24h M2 lab visit / M3 home M4 evening before M6 if rescheduled

05

Sample collectedLab User

Second handoff. Reached only through Log progress, test by test — it cannot be set directly. Multi-visit scans such as a follicular study count up here, 1 of 3, 2 of 3.

M5 next scan due M-REM partial / couple reminders at 3, 7, 14 days

06

Test doneLab User

Every active test line must be complete. The coordinator also records what the patient paid, in what mode, on what date. Commission becomes Earned at this moment and the lead enters the month's statement.

SLA 7 days from capture all lines done payment required

07

Test report generatedLab User

A real PDF must be uploaded — the app checks the %PDF header and the end-of-file marker, so a renamed or truncated file is rejected at the gate. Patient names never appear in the stored filename.

PDF validated · ≤ 10 MB M8 report ready M9 survey 1–5

08

ClosedAdmin only

Third handoff, and the only one that needs the Admin. A lead closes when the report exists and the commission has actually been collected against a partner transfer. Reopenable for 30 days.

report + commission collected reopen window 30 days

By role

## What each seat can and cannot do

Screens are what appears in the top navigation for that role. The limits are enforced on the server as well as hidden in the UI.

Clinic Manager

scope: one clinic

Screens

New leadMy leadsRemindersSearch

Does

- Captures the lead and picks tests from the clinic-visible rate card
- Edits patient details and adds or removes tests early on
- Sends M1 and other patient messages on WhatsApp
- Flags a dispute on a statement line

Only status move

Lead generated → Cancelled

Cannot call, book, schedule, collect or complete. Sees only its own clinic's leads, and never margin figures.

Partner Coordinator

scope: one partner

Screens

QueuesRemindersSearchStatementsRequest lab

Does

- Works the whole middle of the funnel: call, book, schedule, reschedule
- Records the patient payment at Test done
- Uploads reports and logs test progress
- Confirms the monthly statement or flags individual lines
- Requests a new lab be added to the network

Status moves

27 of the 40 — every forward step except Closed, plus follow-ups, not-interested and cancellations.

Cannot close a lead, resolve a dispute, generate a statement, record a transfer, or touch users and rate cards.

Lab User

scope: one lab

Screens

Lab queueSearch

Does

- Logs progress per test, including each scan of a multi-visit study
- Marks samples collected and tests done
- Uploads the report PDF

Status moves

scheduled → Sample collected\
home → Sample collected\
Sample collected → Test done\
Test done → Report generated

The narrowest seat. No calling, booking or scheduling; cannot undo a completed test — that goes back to the coordinator; never sees commission or margin.

Admin

scope: everything

Screens

DashboardQueuesNew leadSearchRemindersSettlementUsersPartners & labsMaster dataDuplicatesDisputesAuditConfig

Does alone

- Closes leads and reopens them within 30 days
- Raises and resolves disputes
- Runs the whole settlement chain
- Creates users, issues temporary passwords, sets scope
- Versions rate cards and activates partners and labs
- Overrides a line price, reroutes a lead to another partner
- Erases a patient's data on a DPDP request

Every one of the 40 status moves, including the four reserved ones: cancelling an unreachable lead, and reviving a Not interested or Cancelled lead.

After Test done

## The settlement chain

Commission is earned at Test done and collected weeks later. Five steps, shared between the Admin and the partner's coordinator.

01

Generate statement

Every lead that reached Test done in the month, by the 3rd of the next month.

Admin

02

Partner review

Coordinator confirms the statement or flags lines they dispute.

Coordinator · 3 days

03

Record transfer

Bank transfer logged with UTR, mode and TDS. Duplicate UTRs are refused.

Admin

04

FIFO allocation

Money is applied to the oldest unpaid lines first, to the paisa.

Automatic

05

Close eligible

Leads with a report and fully collected commission move to Closed.

Admin

Everything else

## Branches off the main path

Most real leads leave the straight line at least once. These are the exits and the way back.

| Situation | Status | Who | What happens |
| --- | --- | --- | --- |
| Patient doesn't pick up | Not reachable | Coordinator | Needs a reason and a future retry time. Returns to Called by lab on the next attempt; auto-cancels after 14 days. |
| Patient wants to wait | Follow-up: After period Follow-up: Will do later | Coordinator | Parked with a future date. M7 fires when the date arrives and the lead returns to Called by lab. |
| Patient declines | Not interested | Coordinator | Revenue voided. Only the Admin can revive it. |
| Same phone, same test, twice | Duplicate review | Admin | Caught at capture within a 30-day window; the clinic must acknowledge before the lead is created, and it lands in the Duplicates queue. |
| Partner disputes a line | Disputed | Admin | Revenue freezes and the lead drops off that month's statement. On resolution it returns to Test done and needs the original month regenerated. |
| Wrong partner routed | — | Admin | Reroute reprices the lead onto the new partner's active rate card. |
| Patient asks to be erased | — | Admin | DPDP erase removes name, mobile, spouse and address everywhere; IDs, dates and amounts stay so commission figures are unaffected. |

Gynoveda DCP v3.0.3 Messaging in MANUAL mode — every M-code is a click-to-WhatsApp button, and each click is logged. Allocation: FIFO