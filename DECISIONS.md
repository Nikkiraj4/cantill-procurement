# Procurement Decision Engine — Design Decisions

## 1. Objective

The application converts employee purchase-request (PR) lines into procurement requirements and evaluates them against a versioned procurement policy.

The decision engine is designed to make policy-driven decisions reproducible and explainable. Each decision should retain its route, policy clause, supplier evidence and pricing basis.

All monetary values are in INR, excluding GST, unless otherwise stated.

## 2. Processing pipeline

The implemented processing flow is:

1. Import master data: plants, items, suppliers, purchase history and contract register.
2. Import signed contract PDFs and their extracted contract-line data.
3. Upload a PR batch CSV.
4. Match PR lines to the item master.
5. Consolidate eligible lines into requirements.
6. Calculate requirement quantities and values.
7. Evaluate active policy rules and supplier eligibility.
8. Review decisions through the buyer workspace; approve, reject or override requirements.
9. Create purchase orders for eligible buyer-approved direct-PO decisions.
9. Export line-level decisions and preferred-supplier rankings.

The stages are separated into scripts so that matching, valuation, decision processing and PO creation can be inspected and validated independently.

## 3. Item matching and new items

- A supplied item code is checked against the item master.
- When a code is not supplied, normalized descriptions and supported aliases are used for matching.
- An unmatched item is treated as a new item.
- New items are routed to `NEW_ITEM_SOURCING`.
- New-item requirements are not clubbed with existing item requirements.
- Lines with invalid or unmapped plant information are held for buyer review.
- A zero or negative quantity must not create a procurement action.

The matching process deliberately avoids silently assigning an unrelated item code.

## 4. Requirement clubbing

The grouping rules follow policy clause 2.2.

Lines can be grouped when they have:

- The same resolved item.
- The same plant.
- Creation dates within 14 calendar days of the first line.
- Need-by dates within plus or minus 7 calendar days of the first line.

When multiple existing groups qualify, the earliest qualifying group is selected.

Requirement ordering is deterministic:

1. Creation time.
2. PR number.
3. PR line number.

The requirement date is the creation date of its first line. Contract validity and purchase-history lookbacks are evaluated relative to that date.

If any line in a requirement is marked emergency, the consolidated requirement is treated as emergency.

## 5. Requirement valuation

Requirement value is calculated as:

`Total requirement quantity × selected unit price`

The pricing hierarchy is:

1. The usable contract rate selected under clause 4.3.
2. If applicable contracts exist but none has enough remaining ceiling, the lowest applicable contract rate is used as the valuation reference.
3. Otherwise, the most recent purchase-history price for the item within the preceding 365 days.
4. If no qualifying purchase history exists, use the item master standard price.

Valuation is performed separately from route selection so that the price basis can be inspected.

## 6. Contract applicability and ceiling

A contract is considered applicable when:

- It covers the requested item.
- The requirement date is on or after the contract start date.
- The requirement date is on or before the contract end date.
- The supplier is active.

A contract is usable only when:

`Consumed value + requirement value at contract rate <= contract ceiling`

Contract ceilings are consumed in requirement-date order.

For multiple usable contracts, the lowest rate with sufficient remaining ceiling is selected.

For signed contracts imported after the register's last update, the imported signed-document evidence is used as the starting point for the relevant contract data. Contract ceiling and validity are checked before a contract PO decision is made.

## 7. Procurement decision rules

Rules are evaluated in priority order. The active policy version supplies the configurable thresholds and supplier-panel counts.

| Priority | Condition | Decision | Route |
|---|---|---|---|
| 1 | Item is new/unmatched | Sourcing | `NEW_ITEM_SOURCING` |
| 2 | Item category is Capex | Sourcing | `CAPEX_SOURCING` |
| 3 | Usable contract exists | PO | `CONTRACT_PO` |
| 4 | Emergency, value within emergency limit, and recent active-supplier purchase exists | PO | `EMERGENCY_PO` |
| 5 | Value below spot limit and recent active-supplier purchase exists | PO | `SPOT_PO` |
| 6 | Value below RFQ/RFP boundary | Sourcing | `RFQ` |
| 7 | Value at or above RFQ/RFP boundary | Sourcing | `RFP` |

For the supplied v5.0 policy, the baseline thresholds are:

- Emergency PO limit: INR 500,000.
- Spot PO limit: INR 200,000.
- RFQ/RFP boundary: INR 1,000,000.
- Capex supplier panel: 5.
- RFQ supplier panel: 3.
- RFP supplier panel: 5.

The v5.0 baseline is interpreted using strict less-than comparisons for spot and RFQ thresholds. The emergency limit is inclusive.

Blocked or inactive suppliers must not be selected for POs or recommendations.

A requirement with zero or negative quantity is marked `NOT_PROCESSED` and must not create a PO.

## 8. Preferred supplier ranking

### Eligibility

A supplier is eligible for an item when the supplier is active and either:

- It has purchase history for the item within the preceding 548 days; or
- It has a contract line covering the item and the contract started on or before the as-of date.

Contract expiry does not by itself remove a supplier from the preferred-list eligibility set. This follows clause 6.1.

### Ranking formula

The implementation uses a weighted score:

| Factor | Weight |
|---|---:|
| Purchase frequency | 0.30 |
| Purchase recency | 0.25 |
| Contract holding | 0.20 |
| On-time delivery | 0.15 |
| Quality | 0.10 |
| **Total** | **1.00** |

The score is calculated from normalized factor values. Higher scores rank ahead of lower scores. Supplier ID is used as a deterministic tie-breaker.

The weights are an explicit implementation choice because the policy describes the ranking factors but does not prescribe numerical weights.

### Reference price

The reference price is:

1. The most recent purchase-order price for that item within the 548-day lookback; or
2. If no qualifying purchase exists, the rate from the most recently started contract covering the item and started on or before the as-of date.

The preferred-supplier export contains up to three ranked suppliers per item.

Items with no eligible suppliers are retained as placeholder rows with blank rank, supplier ID and reference price. This ensures every item-master item is represented in the export.

## 9. Purchase-order consolidation

Only direct-PO decisions are eligible for PO creation.

The implemented PO creation stage groups requirements by:

- Supplier.
- Plant.
- Procurement route.
- A 24-hour window from the first requirement's creation time.

Requirements are processed in creation order and join the earliest qualifying open PO. Otherwise, a new PO is created.

Sourcing decisions are not converted into POs by this stage.

## 10. Policy versioning and amendment demonstration

Policy rules are stored against `PolicyVersion` records. The active version is selected from the database rather than fixed to a version number in the decision script.

The policy-management workflow supports:

1. Uploading a readable PDF amendment.
2. Extracting PDF text.
3. Creating a draft policy version.
4. Copying the existing policy rules into the draft.
5. Applying supported threshold and supplier-count changes from the amendment form.
6. Reviewing the change summary.
7. Approving the draft.
8. Retiring the previous active version and activating the approved version.

The current implementation supports configuration of the emergency limit, spot limit, RFQ/RFP boundary, and Capex/RFQ/RFP supplier counts through the amendment workflow. It does not yet translate arbitrary new policy prose into entirely new executable rule types.

### Assessment demonstration note

The v5.1 amendment used during development is a clearly labelled test amendment created because the supplied assessment kit did not contain a v5.1 amendment PDF.

It demonstrates the versioning workflow and is not evidence of an actual Corvo Engineering policy approval.

The test amendment changes:

- Emergency limit: INR 500,000 to INR 600,000.
- Spot limit: INR 200,000 to INR 250,000.
- RFQ/RFP boundary: INR 1,000,000 to INR 1,200,000.
- RFQ supplier count: 3 to 4.

Other policy clauses and supplier counts remain unchanged in that demonstration.

## 11. Auditability and validation

The implementation uses dry-run modes for processing scripts before database writes.

Important safeguards include:

- Batch-scoped requirement, decision and PO processing.
- Active policy lookup by document code and status.
- Validation of required policy rules before decision processing.
- Supplier active-status checks.
- Contract ceiling checks.
- PO-line value validation.
- Exclusion of sourcing decisions from direct PO creation.
- Explicit handling of zero-quantity requirements.
- Buyer approval, rejection and override actions are recorded with timestamps and audit events.
- Overrides require a comment and validate the selected route, supplier and positive unit price where applicable.
- PO generation requires eligible buyer-approved or overridden direct-PO decisions and refuses duplicate batch PO creation.
- Buyer names are manually entered and are not independently authenticated.
- CSV export validation against the source batch line count.

A decision should be explainable through its policy version, clause, selected supplier, price basis and contract or purchase-history evidence.

## 12. Assumptions and limitations

- The supplied assessment data is treated as fictional procurement data.
- All calculations use INR and exclude GST.
- Source timestamps are interpreted consistently by the import and processing scripts; the current source-data workflow treats the supplied local timestamps as UTC.
- Supplier-ranking weights are implementation choices documented above, not weights prescribed by the source policy.
- The policy amendment demo uses a test-only PDF and a demo approver label.
- Natural-language employee chat intake and full arbitrary-policy-to-rule interpretation are not represented as completed features in this implementation.
- The API exposes batch upload, batch processing, dashboard and policy-management routes.


## 13. Blind-test execution note — 19 November 2026

The preferred-supplier export was generated for the requested as-of date of 1 December 2026 and saved as `submission/nikitakumari__preferred.csv`.

The two blind-test decision exports were not generated. The existing database had historical requirements, decisions and preferred-supplier snapshots under both stored policy versions. The decision processor selects the active policy and includes a safeguard that prevents applying a batch when preferred-supplier snapshots already exist for that policy.

The active policy at inspection time was a development test amendment, not the requested v5.0 baseline. The supplied blind-test amendment also includes a Packaging-specific spot limit and a Chakan electrical-safety override, which are not supported by the existing amendment configuration workflow.

No application source code was changed after the stated code-freeze time. Existing sample-batch exports were not relabelled as blind-test results.
