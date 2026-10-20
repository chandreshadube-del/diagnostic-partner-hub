# Diagnostic Partner Hub

Project DCP — the app Gynoveda uses to move a diagnostic lead from a clinic
desk to a settled partner commission. A lead is captured at a clinic, called
and booked by the partner's coordinator, collected and completed by a lab, and
closed by an admin once the report exists and the commission has been
collected.

## Layout

| Path | What it is |
| --- | --- |
| `apps-script/` | the production server, v3.0.3 — Google Apps Script over a 22-tab Google Sheet ([setup and deploy](apps-script/README.md)) |
| `docs/DCP_Role_Workflows.md` | who does what, and when: the eight stages, the four roles, the settlement chain, and every branch off the main path |
| `docs/DATA_MODEL.md` | the 22 tabs of the master seed — tab names, columns, row counts |
| `docs/PRIVACY.md` | why the seed workbook is not committed here |
| `index.html` | an earlier standalone browser prototype, kept for reference |

The prototype in `index.html` predates the Apps Script app and uses its own
simplified status list (Pending → Handed over to Lab → … → Delivered). The
statuses the server actually enforces are the ones in `TRANSITIONS` in
`apps-script/Code.gs`, described in `docs/DCP_Role_Workflows.md`.

## The shape of it

Four roles, scoped on the server as well as hidden in the UI: Clinic Manager
(one clinic), Partner Coordinator (one partner), Lab User (one lab), Admin
(everything). Eight stages on the main path with three handoffs, 40 permitted
status transitions, and SLA clocks that start the moment a stage is entered.

Prices freeze onto a lead at capture, against the rate card active that day —
tests added later are priced on that same card, never today's. Commission is
earned at Test done, frozen if the partner disputes a line, and collected
weeks later through statement → partner review → bank transfer → FIFO
allocation → close.

Messaging runs in MANUAL mode: every M-code is a click-to-WhatsApp button, and
every click is logged.

## Data

The app reads a Google Sheet, not a database in this repository. The seed
workbook carries live patient records and staff password hashes, so it is not
committed and `.gitignore` blocks `*.xlsx` and `*.csv` as a backstop. Read
[docs/PRIVACY.md](docs/PRIVACY.md) before adding data of any kind.
