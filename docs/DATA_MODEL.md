# DCP master seed — data model

Structure of `DCP_App_Master_Seed_v1.xlsx`, the 22-tab Google Sheet that backs the
Apps Script app in `apps-script/`. Tab names match the `SH` map at the top of
`Code.gs`; column names match the header row the app reads by name.

**The workbook itself is not in this repository.** It carries live patient records
and staff credentials — see [PRIVACY.md](PRIVACY.md). Row counts below are from the
seed as received on 2026-10-20 and exclude the header row.

| Tab | Rows | Cols | Contents |
| --- | ---: | ---: | --- |
| [Config](#config) | 35 | 6 | Reference |
| [Users](#users) | 37 | 17 | PII + credentials |
| [Regions](#regions) | 4 | 4 | Reference |
| [Areas](#areas) | 7 | 6 | Reference |
| [Clinics](#clinics) | 27 | 22 | Business contacts |
| [Partners](#partners) | 3 | 22 | Business contacts |
| [Labs](#labs) | 256 | 19 | Business contacts |
| [Tests](#tests) | 34 | 11 | Reference |
| [Packages](#packages) | 18 | 10 | Reference |
| [RateCards](#ratecards) | 117 | 18 | Commercial |
| [Leads](#leads) | 1190 | 51 | Patient PII |
| [LeadTests](#leadtests) | 2870 | 17 | Linked to patient |
| [Reports](#reports) | 1 | 12 | Linked to patient |
| [Messages](#messages) | 1 | 12 | Patient PII |
| [Templates](#templates) | 10 | 9 | Reference |
| [Statements](#statements) | 3 | 12 | Commercial |
| [StatementLines](#statementlines) | 474 | 13 | Commercial |
| [Transfers](#transfers) | 1 | 12 | Commercial |
| [Allocations](#allocations) | 1 | 7 | Commercial |
| [Audit](#audit) | 1 | 12 | Mixed |
| [ClinicFootfall](#clinicfootfall) | 36 | 14 | Reference |
| [DuplicateReviews](#duplicatereviews) | 69 | 13 | Patient PII |

---

## Config

35 rows · 6 columns · Reference

```
Key
Value
Category
Description
UpdatedAt
UpdatedBy
```

## Users

37 rows · 17 columns · PII + credentials

> Holds staff names, mobiles, PBKDF2 password hashes.

```
UserID
Email
Name
Mobile
Role
OrgType
OrgID
ScopeType
ScopeIDs
PasswordHash
TempPasswordExpiry
FailedAttempts
LockedUntil
ForcePasswordChange
Active
CreatedAt
Notes
```

## Regions

4 rows · 4 columns · Reference

```
RegionID
Name
Active
Notes
```

## Areas

7 rows · 6 columns · Reference

```
AreaID
RegionID
Name
PilotScope
Active
Notes
```

## Clinics

27 rows · 22 columns · Business contacts

> Holds clinic manager names and emails.

```
ClinicID
Name
AreaID
RegionID
City
State
Address
Landmark
Pincode
ClinicPhone
DefaultPartnerID
ClinicManagerName
ClinicManagerEmail
ReferringDoctors
Status
MappedDCCount
Sep2026Leads
Sep2026TestDone
AugOctLeads
AugOctCompleted
AugOctOpen
AugOctConvPct
```

## Partners

3 rows · 22 columns · Business contacts

> Holds partner contact names, mobiles, emails.

```
PartnerID
LegalName
DisplayName
Type
State
AgreementRef
AgreementDate
EffectiveDate
ValidityMonths
PrimaryContactName
PrimaryContactMobile
PrimaryContactEmail
EscalationContactName
EscalationContactMobile
EscalationContactEmail
ClientAdminEmails
CallingNumber
ReportSharingMethod
CommissionRule
SettlementCycle
LateInterestRule
Notes
```

## Labs

256 rows · 19 columns · Business contacts

> Holds lab manager names, mobiles, emails.

```
LabID
PartnerID
LabName
ClinicIDServed
AreaName
Address
Pincode
MapsLink
LabPhone
SecondaryPhone
LabManagerName
LabManagerMobile
LabManagerEmail
Modes
HomeCollectionPincodes
TestsPerformed
NABLCertNumber
State
Notes
```

## Tests

34 rows · 11 columns · Reference

```
TestCode
Name
Category
GenderApplicability
MaleOnly
ScansRequired
DefaultTATHours
HomeCollectionAllowed
PreparationNotes
Active
Notes
```

## Packages

18 rows · 10 columns · Reference

```
PackageCode
Name
FemaleTests
FemaleTestCodes
MaleTests
MaleTestCodes
TotalComponentTests
IncludesScans
ActiveInPilot
Notes
```

## RateCards

117 rows · 18 columns · Commercial

> Holds MRP, patient price, partner share, margin.

```
RateCardID
PartnerID
Version
ItemType
ItemCode
ItemName
MRP
PatientPrice
GynovedaMarginRs
PartnerB2BShareRs
MarginPctOfMRP
ContractualMarginRs
CRMDiscrepancyNote
TATHours
HomeCollectionAllowed
VisibleToClinics
EffectiveFrom
State
```

## Leads

1190 rows · 51 columns · Patient PII

> Holds patient name, mobile, age, pincode, collection address, spouse name.

```
LeadID
LegacyCRMLeadID
CreatedAt
ClinicID
PartnerID
AssignedLabID
PatientName
Gender
Age
Phone
Pincode
BookingType
SpouseName
SpouseAge
SpouseGender
ReferringDoctor
Urgency
PreferredMode
BookingMode
ApptDate
ApptSlot
CollectionAddress
NotesForLab
ConsentTicked
ConsentBy
ConsentAt
Status
FollowUpCategory
FollowUpDate
FollowUpReason
CancelReason
NotReachableReason
RetryAt
SampleCollectedAt
ScansCompleted
ScansTotal
TestDoneAt
PaymentAmount
PaymentMode
PaymentDate
PaymentRef
PatientDiscountRs
ExpectedMRP
ExpectedPatientPrice
ExpectedMarginRs
RevenueState
ReportGeneratedAt
ClosedAt
OptOut
LastUpdatedAt
LastUpdatedBy
```

## LeadTests

2870 rows · 17 columns · Linked to patient

> Holds per-patient test lines, keyed to Leads.

```
LeadTestID
LeadID
PersonTag
ItemType
ItemCode
ItemName
FrozenMRP
FrozenPatientPrice
FrozenMarginRs
PartnerShareRs
ScansRequired
ScansDone
IsDone
DoneAt
AddedByRole
AddedAt
Active
```

## Reports

1 rows · 12 columns · Linked to patient

> Holds report file handles per lead.

```
ReportID
LeadID
PersonTag
FileID
FileName
DrivePath
FileSizeMB
UploadedBy
UploadedAt
Active
ReplacedBy
Notes
```

## Messages

1 rows · 12 columns · Patient PII

> Holds recipient mobile numbers.

```
MsgID
LeadID
TemplateCode
Channel
Mode
RecipientPhone
Status
SentByUserID
SentAt
DeliveredAt
ReadAt
ErrorNote
```

## Templates

10 rows · 9 columns · Reference

```
TemplateCode
Name
TriggerEvent
Channel
BodyText
VariablesUsed
WhatsAppTemplateID
SMSTemplateID
Active
```

## Statements

3 rows · 12 columns · Commercial

> Holds partner payout totals.

```
StatementID
PartnerID
MonthYYYYMM
TotalTestDoneLeads
PatientCollectedTotalRs
MarginEarnedContractualRs
MarginBookedCRMRs
DiscrepancyGapRs
Status
GeneratedAt
ConfirmedAt
Notes
```

## StatementLines

474 rows · 13 columns · Commercial

> Holds per-lead margin and variance.

```
StatementLineID
StatementID
LeadID
LegacyCRMLeadID
ClinicID
TestDoneDate
TestsSummary
PatientPriceRs
ContractualMarginRs
CRMMarginRs
VarianceRs
LineStatus
FlagNote
```

## Transfers

1 rows · 12 columns · Commercial

> Holds bank UTRs, TDS.

```
TransferID
PartnerID
TransferDate
AmountRs
UTR
PaymentMode
TDSDeductedRs
AllocatedAmountRs
UnallocatedAmountRs
RecordedBy
RecordedAt
Notes
```

## Allocations

1 rows · 7 columns · Commercial

> Holds payout allocation.

```
AllocationID
TransferID
StatementID
LeadID
AllocatedAmountRs
AllocatedAt
AllocatedBy
```

## Audit

1 rows · 12 columns · Mixed

> Holds before/after JSON may embed patient fields.

```
AuditID
Timestamp
UserID
UserEmail
Role
Action
LeadID
Entity
EntityRef
BeforeJSON
AfterJSON
Note
```

## ClinicFootfall

36 rows · 14 columns · Reference

```
RecordID
ClinicID
ClinicName
AreaID
MonthYYYYMM
Footfall1Cx
DCPLeads
AdoptionPct
TargetAdoptionPct
TestDoneCount
ConversionPct
EarnedCommissionRs
DataSource
Notes
```

## DuplicateReviews

69 rows · 13 columns · Patient PII

> Holds patient name and phone of suspected duplicates.

```
ReviewID
DetectedAt
PrimaryLeadID
DuplicateLeadID
PatientName
Phone
Clinic1
Clinic2
OverlappingTests
DaysApart
ResolutionStatus
ResolvedBy
ResolutionNote
```
