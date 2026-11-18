# Cantill Procurement

A procurement workflow application for importing purchase requests, consolidating requirements, evaluating policy-driven procurement routes, generating purchase orders and reviewing policy versions.

## 1. Technology

- Frontend: React 19, Vite, React Router, Recharts and Lucide React.
- Backend: Node.js, Express and Prisma.
- Database: PostgreSQL.
- CSV processing: csv-parse and PapaParse.
- PDF text extraction: PDF.js (`pdfjs-dist`).

## 2. Project structure

```text
cantill-procurement/
├── backend/
│   ├── prisma/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── batch.routes.js
│   │   │   ├── dashboard.routes.js
│   │   │   └── policy.routes.js
│   │   ├── scripts/
│   │   └── server.js
│   └── package.json
├── frontend/
│   ├── src/
│   └── package.json
├── data/
│   └── source/
├── docs/
├── submission/
├── DECISIONS.md
├── APPROACH.md
└── README.md
```

## 3. Prerequisites

Install:

- Node.js 22 or a compatible newer LTS release.
- npm.
- Docker Desktop.
- Git.

The application uses PostgreSQL. The setup below runs PostgreSQL in a Docker container; it does not require Docker Compose.

## 4. Start PostgreSQL

Start Docker Desktop, then run:

```bash
docker run --name cantill-postgres \
  -e POSTGRES_USER=cantill \
  -e POSTGRES_PASSWORD=cantill_local_dev \
  -e POSTGRES_DB=cantill_procurement \
  -p 5432:5432 \
  -v cantill_postgres_data:/var/lib/postgresql/data \
  -d postgres:16
```

If the container already exists, start it instead:

```bash
docker start cantill-postgres
```

Check that PostgreSQL is ready:

```bash
docker exec cantill-postgres pg_isready \
  -U cantill -d cantill_procurement
```

## 5. Configure the backend

Open a terminal:

```bash
cd backend
npm install
```

Set the database connection string in the same terminal:

```bash
export DATABASE_URL="postgresql://cantill:cantill_local_dev@localhost:5432/cantill_procurement?schema=public"
```

Generate the Prisma client and synchronize the schema:

```bash
npx prisma generate
npx prisma db push
```

For a new local database, import the supplied master data:

```bash
node src/scripts/import-master-data.js
node src/scripts/import-signed-contracts.js
```

The source data must be present in the expected `data/source/` directory at the project root. The scripts use the supplied assessment data paths.

Start the backend:

```bash
npm run dev
```

The API runs at:

- `http://localhost:5000`
- Health check: `http://localhost:5000/api/health`

Keep this terminal running.

## 6. Start the frontend

Open a second terminal:

```bash
cd ~/Desktop/cantill-procurement/frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal, normally:

`http://localhost:5173`

The frontend uses `VITE_API_URL` when supplied. Otherwise, it defaults to `http://localhost:5000`.

For a separately hosted frontend, set `VITE_API_URL` to the deployed backend base URL before building.

## 7. Application sections

### Overview
Displays procurement summary metrics, decision distribution, procurement value, recent requirements and imported batches.

### Requirements
Displays consolidated procurement requirements and their decision information.

### Purchase Orders
Displays generated purchase orders and their values.

### Sourcing Requests
Displays sourcing work and supplier recommendations where available.

### Policy Management
Supports uploading a readable policy-amendment PDF, creating a draft policy version, reviewing supported changes and approving the draft.

### Buyer Workspace
Supports reviewing procurement decisions, viewing supplier recommendations and decision evidence, approving or rejecting requirements, and recording commented overrides. Purchase-order generation is restricted to buyer-approved or overridden direct-PO decisions.

## 8. API overview

The Express API exposes these route groups:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/` | API identity and status |
| GET | `/api/health` | Database connectivity check |
| POST | `/api/batches/upload` | Upload a PR batch |
| GET | `/api/dashboard/summary` | Dashboard summary |
| GET | `/api/dashboard/requirements` | Requirement records |
| GET | `/api/dashboard/purchase-orders` | Purchase-order records |
| GET | `/api/dashboard/sourcing-requests` | Sourcing-request records |
| GET | `/api/dashboard/batches` | Imported batches |
| GET | `/api/policies` | Policy-version history |
| POST | `/api/policies/upload` | Upload a policy PDF and create a draft |
| POST | `/api/policies/:id/approve` | Approve a draft policy version |
| POST | `/api/buyer/requirements/:requirementId/action` | Approve, reject or override a requirement |
| POST | `/api/buyer/batches/:batchId/generate-purchase-orders` | Generate purchase orders for eligible buyer-approved decisions |

The policy upload endpoint expects a multipart PDF field named `policyPdf` and structured amendment fields. The PDF must contain extractable text; scanned PDFs without readable text are rejected.

## 9. Procurement processing scripts

The backend scripts separate the main processing stages:

| Script | Purpose |
|---|---|
| `import-master-data.js` | Import plants, items, suppliers, history and contract register data |
| `import-signed-contracts.js` | Import signed contract information |
| `import-pr-batch.js` | Import the sample PR batch |
| `match-requirements.js` | Resolve items and identify requirement groups |
| `create-requirements.js` | Create consolidated requirements |
| `value-requirements.js` | Calculate requirement values and price evidence |
| `process-procurement-decisions.js` | Evaluate active policy rules and supplier recommendations |
| `create-purchase-orders.js` | Create POs for eligible direct-PO decisions |
| `export-baseline.js` | Export batch-level procurement decisions and policy-linked preferred suppliers |
| `export-preferred-suppliers.js` | Export preferred suppliers as of a specified date |

Run scripts from the `backend/` directory. Use the script's dry-run option before applying changes wherever supported. Follow the batch ID and arguments printed by the relevant script; do not reuse a batch ID from another environment.

## 10. Submission exports

The assessment exports are stored in `submission/`.

Expected deliverables:

- `decisions_v5.0.csv`
- `decisions_v5.1.csv`
- `preferred_suppliers_as_of_2026-11-18.csv`

The decision exports contain one row per source PR line. The preferred-supplier export contains up to three ranked suppliers per item and placeholder rows for items without eligible suppliers.

The preferred supplier ranking uses a 548-day lookback and the weighted factors documented in `DECISIONS.md`.

## 11. Policy demonstration

The supplied assessment kit includes the v5.0 procurement policy. It did not include an actual v5.1 amendment PDF.

For the local demonstration, a clearly labelled test amendment was created and uploaded through Policy Management. It demonstrates draft creation, PDF text extraction, supported threshold updates, approval and policy-version activation.

The test amendment and its demo approver label are not actual Corvo Engineering policy authorization.

See `DECISIONS.md` for the exact demonstration changes and supported policy behavior.

## 12. Important implementation notes

- The application uses CSV-based PR batch intake.
- The policy workflow supports a defined set of configurable thresholds and supplier counts; it does not automatically convert arbitrary policy prose into new executable rule types.
- Natural-language employee chat intake is not implemented as a complete workflow in this version.
- Buyer names are manually entered for audit records; the application does not authenticate buyer identity.
- The API does not currently expose a `/api/process-batch` endpoint; batch upload and subsequent processing are separate stages.
- Buyer approval and override actions are recorded with timestamps and audit events. Overrides require a comment. PO generation checks buyer approval status and prevents duplicate batch PO creation.
- The local setup uses a manually started PostgreSQL container. A Docker Compose configuration is not included.

## 13. Design and implementation notes

- Procurement rules, assumptions, ranking weights and trade-offs: `DECISIONS.md`.
- Development process and AI assistance: `APPROACH.md`.
