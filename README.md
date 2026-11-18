# Cantill Procurement

**A policy-driven procurement workflow and decision management application.**

Cantill Procurement transforms purchase request (PR) data into consolidated procurement requirements, evaluates them against versioned procurement policies, recommends suppliers, and supports buyer-reviewed purchase-order generation.

## Live Application

| Component | URL |
|---|---|
| **Frontend** | [Cantill Procurement](https://cantill-procurement-omega.vercel.app/) |
| **Backend API** | [Railway API](https://cantill-procurement-production-32e9e137.up.railway.app/) |
| **API Health Check** | [Check API and Database](https://cantill-procurement-production-32e9e137.up.railway.app/api/health) |

The frontend is deployed on Vercel, the Express backend runs on Railway, and PostgreSQL is hosted on Railway.

The production health endpoint verifies API availability and database connectivity.

## 1. Technology Stack

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
- Zod
- Multer
- csv-parse
- PDF.js (`pdfjs-dist`)

### Database and Deployment
- PostgreSQL
- Railway — backend and database hosting
- Vercel — frontend hosting
- GitHub — source control

## 2. Key Features

### Procurement Dashboard
- Procurement summary metrics.
- Decision distribution and procurement value.
- Recent requirements and imported batches.
- Purchase-order and sourcing-request visibility.

### Purchase Request Processing
- CSV-based PR batch intake.
- Item matching against the item master.
- Requirement consolidation based on policy criteria.
- Requirement valuation using contract and purchase-history evidence.
- Batch-level processing and traceability.

### Procurement Decision Engine
- Policy-driven procurement route selection.
- Direct purchase-order and sourcing decisions.
- Emergency, spot purchase, RFQ and RFP evaluation.
- Supplier eligibility checks and recommendations.
- Explainable decisions with policy and pricing evidence.

### Policy Management
- PDF policy-amendment upload.
- PDF text extraction.
- Draft policy-version creation.
- Supported threshold and supplier-count updates.
- Policy review and approval.
- Activation of approved policy versions.

### Buyer Workspace
- Review procurement decisions and supplier recommendations.
- Approve or reject requirements.
- Record commented decision overrides.
- Maintain buyer-action audit events.
- Generate purchase orders only for eligible buyer-approved or overridden direct-PO decisions.

## 3. Project Structure

```text
cantill-procurement/
├── backend/
│   ├── prisma/
│   │   ├── migrations/
│   │   └── schema.prisma
│   ├── src/
│   │   ├── routes/
│   │   ├── scripts/
│   │   └── server.js
│   ├── package.json
│   └── prisma.config.ts
├── frontend/
│   ├── public/
│   ├── src/
│   ├── index.html
│   └── package.json
├── submission/
├── docs/
├── DECISIONS.md
├── APPROACH.md
└── README.md
```

## 4. Prerequisites

For local development, install:

- Node.js 22 or a compatible newer version.
- npm.
- Docker Desktop.
- Git.

The backend requires PostgreSQL.

## 5. Local Setup

### Step 1: Clone the repository

```bash
git clone https://github.com/Nikkiraj4/cantill-procurement.git

cd cantill-procurement
```

### Step 2: Start PostgreSQL

Start Docker Desktop and run:

```bash
docker run --name cantill-postgres \
  -e POSTGRES_USER=cantill \
  -e POSTGRES_PASSWORD=cantill_local_dev \
  -e POSTGRES_DB=cantill_procurement \
  -p 5432:5432 \
  -v cantill_postgres_data:/var/lib/postgresql/data \
  -d postgres:16
```

If the container already exists:

```bash
docker start cantill-postgres
```

Check database readiness:

```bash
docker exec cantill-postgres pg_isready \
  -U cantill -d cantill_procurement
```

### Step 3: Configure and start the backend

Open a terminal:

```bash
cd backend

npm install
```

Configure the local database connection:

```bash
export DATABASE_URL="postgresql://cantill:cantill_local_dev@localhost:5432/cantill_procurement?schema=public"
```

Generate the Prisma client:

```bash
npx prisma generate
```

Apply the existing database migrations:

```bash
npx prisma migrate deploy
```

Start the backend:

```bash
npm run dev
```

The backend runs at:

`http://localhost:5000`

Health check:

`http://localhost:5000/api/health`

### Step 4: Configure and start the frontend

Open a second terminal:

```bash
cd frontend

npm install
```

Start the development server:

```bash
npm run dev
```

Open the Vite URL printed in the terminal, normally:

`http://localhost:5173`

By default, the frontend uses `http://localhost:5000` as its API URL.

To connect the frontend to another backend, configure `VITE_API_URL` before starting or building the application.

## 6. Environment Variables

Never commit environment files, database credentials, or production secrets to GitHub.

### Backend

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Backend server port; defaults to `5000` |

### Frontend

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Base URL of the backend API |

For the deployed frontend, `VITE_API_URL` points to:

```text
https://cantill-procurement-production-32e9e137.up.railway.app
```

The frontend environment variable must be available during the Vite build.

## 7. Application Sections

| Section | Functionality |
|---|---|
| Overview | Procurement metrics, decision distribution and recent activity |
| Requirements | Consolidated requirements and procurement decisions |
| Purchase Orders | Generated purchase orders and associated values |
| Sourcing Requests | Sourcing work and supplier recommendations |
| Policy Management | Policy uploads, drafts, amendments and approvals |
| Buyer Workspace | Buyer review, approval, rejection and overrides |

## 8. API Overview

The Express backend exposes the following API endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/` | API identity and status |
| GET | `/api/health` | API and database connectivity |
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
| POST | `/api/buyer/batches/:batchId/generate-purchase-orders` | Generate eligible purchase orders |

Policy uploads use multipart form data with a PDF field named `policyPdf` and structured amendment fields.

The PDF must contain extractable text. Scanned PDFs without readable text are rejected.

## 9. Procurement Processing Scripts

The backend separates procurement processing into dedicated scripts:

| Script | Purpose |
|---|---|
| `import-master-data.js` | Import plants, items, suppliers, purchase history and contract register data |
| `import-signed-contracts.js` | Import signed contract information |
| `import-pr-batch.js` | Import a PR batch |
| `match-requirements.js` | Match items and identify requirement groups |
| `create-requirements.js` | Create consolidated requirements |
| `value-requirements.js` | Calculate requirement values and pricing evidence |
| `process-procurement-decisions.js` | Evaluate active policy rules and supplier recommendations |
| `create-purchase-orders.js` | Create purchase orders for eligible direct-PO decisions |
| `export-baseline.js` | Export batch-level procurement decisions |
| `export-preferred-suppliers.js` | Export preferred suppliers as of a specified date |

Run scripts from the `backend/` directory.

Use dry-run options wherever supported and verify the target batch before applying database changes.

**Important:** These scripts modify database records. In particular, `import-master-data.js` replaces existing purchase-history data during its import process. Do not run import or processing scripts against an existing production database unless an intentional data refresh is required and a backup has been taken.

## 10. Submission Exports

The assessment exports are maintained in `submission/`.

Expected deliverables include:

- `decisions_v5.0.csv`
- `decisions_v5.1.csv`
- `preferred_suppliers_as_of_2026-11-18.csv`

The decision exports contain one row per source PR line.

The preferred-supplier export contains up to three ranked suppliers per item, with placeholder rows for items without eligible suppliers.

## 11. Policy Demonstration

The supplied assessment kit included the v5.0 procurement policy but did not include an actual v5.1 amendment PDF.

A clearly labelled test amendment was created for the local demonstration.

The demonstration covers:

1. PDF upload and text extraction.
2. Draft policy-version creation.
3. Supported threshold and supplier-count updates.
4. Policy review and approval.
5. Activation of the approved policy version.

The test amendment and its demo approver label are not actual Corvo Engineering policy authorization.

Refer to `DECISIONS.md` for the exact demonstration changes and supported policy behavior.

## 12. Deployment Architecture

The application is deployed as separate frontend and backend services.

```text
                 User / Browser
                       |
                       v
             Vercel Frontend
             React + Vite
                       |
                       | VITE_API_URL
                       v
              Railway Backend
              Node.js + Express
                       |
                       v
               Prisma ORM
                       |
                       v
              Railway PostgreSQL
```

### Production URLs

- Frontend: https://cantill-procurement-omega.vercel.app/
- Backend: https://cantill-procurement-production-32e9e137.up.railway.app/
- Health check: https://cantill-procurement-production-32e9e137.up.railway.app/api/health

### Deployment workflow

1. Source code is maintained in the GitHub repository.
2. The frontend is deployed through Vercel using the `frontend` directory.
3. The backend is deployed through Railway using the `backend` directory.
4. Railway PostgreSQL stores application data.
5. The frontend communicates with the backend through `VITE_API_URL`.

Pushing changes to the connected GitHub `main` branch triggers the configured deployment workflows.

## 13. Important Implementation Notes and Limitations

- The application uses CSV-based purchase-request intake.
- Policy management supports a defined set of configurable thresholds and supplier counts; arbitrary policy prose is not automatically converted into new executable rule types.
- Natural-language employee chat intake is not implemented as a complete workflow in this version.
- Buyer names are manually entered for audit records; buyer identity is not independently authenticated.
- Batch upload and subsequent processing are separate stages.
- Buyer approval and override actions are recorded with timestamps and audit events.
- Overrides require a comment.
- Purchase-order generation checks buyer approval status and prevents duplicate batch PO creation.
- Local development uses a manually started PostgreSQL container; Docker Compose is not included.

## 14. Design and Development Documentation

For additional implementation details, refer to:

- **[APPROACH.md](APPROACH.md)** — implementation approach, technology choices, validation and AI assistance.
- **[DECISIONS.md](DECISIONS.md)** — procurement rules, assumptions, ranking weights, policy behavior and design trade-offs.