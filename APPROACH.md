# Implementation Approach and AI Usage

## 1. Project approach

The solution was developed in small, verifiable stages, starting with the supplied procurement data and policy rather than hardcoding decisions around individual PR numbers.

The main objective was to make procurement processing reproducible and to keep policy configuration separate from the decision-processing workflow wherever the implementation supports it.

## 2. Technology stack

### Frontend
- React 19
- Vite
- React Router
- Recharts
- Lucide React
- PapaParse
- CSS

### Backend
- Node.js
- Express
- Prisma ORM
- PostgreSQL
- Zod
- csv-parse
- Multer
- PDF.js (`pdfjs-dist`)

## 3. Data and database approach

The supplied source files are imported into PostgreSQL through dedicated scripts.

The import process covers:

- Plant master.
- Item master.
- Supplier master.
- Purchase-order history.
- Contract register and contract lines.
- Signed contract PDF data.
- PR batch headers and PR lines.

The source CSV files are retained separately from the application code. Imported records are linked through database relationships, while original line data is retained for traceability and review of unmapped values.

## 4. Processing stages

The backend separates procurement processing into dedicated scripts:

- `import-master-data.js`
- `import-signed-contracts.js`
- `import-pr-batch.js`
- `match-requirements.js`
- `create-requirements.js`
- `value-requirements.js`
- `process-procurement-decisions.js`
- `create-purchase-orders.js`
- `export-baseline.js`
- `export-preferred-suppliers.js`

The processing scripts support dry-run checks where implemented. Database writes are performed only after the relevant validation stage.

Batch IDs are used to scope processing so that a re-run or test batch does not accidentally process unrelated batches.

## 5. Policy as data

Policy versions and their rules are stored in database records.

The decision processor loads the active policy version and reads configured rule conditions and outcomes. This avoids pinning the processor to a particular policy version.

The policy-management API accepts a PDF amendment, extracts readable text, creates a draft version and copies the existing rules. Supported decision thresholds and supplier counts are updated through structured amendment fields. An approver action retires the previous active version and activates the draft.

This is a controlled configuration workflow. It is not a general-purpose language model that can safely convert any arbitrary policy document into executable rules without review.

## 6. Testing and validation

Validation was performed using the supplied sample PR batch and the test amendment workflow.

The checks included:

- Master-data import counts.
- PR batch row and header counts.
- Item matching and requirement grouping.
- Requirement valuation and source-price selection.
- Policy rule availability.
- Supplier eligibility and ranking.
- Contract validity and remaining ceiling.
- Direct-PO decision eligibility.
- PO consolidation and line-value checks.
- Zero-quantity handling.
- CSV row counts and item coverage.
- Buyer action validation, required override comments and buyer audit-event creation.
- PO-generation approval checks and duplicate-batch safeguards..

The v5.1 test batch produced 150 requirements, 101 direct-PO decisions and 87 purchase orders. The created purchase orders contained 101 lines.

The decision exports contain 186 rows each, matching the 186 source PR lines. The preferred-supplier export contains 160 rows covering all 73 item-master items, including five placeholder rows for items without eligible suppliers.

These figures describe the local assessment demonstration dataset and should not be interpreted as production performance metrics.

## 7. AI tools and assistance

AI assistance (ChatGPT) was used as a development aid for:

- Breaking down the assessment requirements into implementation stages.
- Reasoning through procurement-policy clauses and edge cases.
- Reviewing code structure and suggesting implementation approaches.
- Debugging runtime, Prisma, PDF extraction and data-processing errors.
- Designing validation checks for requirement grouping, valuation, supplier eligibility and PO creation.
- Preparing documentation and explaining technical decisions.

AI-generated suggestions were reviewed against the supplied policy, source data, application code and command-line test results before being used.

The procurement rules, ranking weights, assumptions and known limitations are documented in `DECISIONS.md`. AI assistance did not replace validation of the outputs against the assessment data.

## 8. Known implementation gaps

The current implementation focuses on the CSV-based procurement workflow, policy versioning, decision processing, purchase-order generation and dashboard.

The following assessment capabilities are not represented as complete in this version:

- Natural-language employee chat intake and clarification.
- Arbitrary new policy-rule-type extraction from unstructured policy amendments.
- A dedicated `/api/process-batch` endpoint matching that exact assessment route.
- Buyer identity authentication; buyer names are manually recorded.
- A Docker Compose one-command environment.

These gaps are stated explicitly rather than described as completed functionality.
