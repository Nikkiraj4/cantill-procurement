import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = path.resolve(__dirname, "../../../");
const SUBMISSION_DIR = path.join(PROJECT_ROOT, "submission");
const BATCH_ID = process.argv[2];
const AS_OF_DATE = process.argv[3] || "2026-11-18";
const OVERWRITE = process.argv.includes("--overwrite");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(headers, rows) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
}

async function writeExport(filePath, content) {
  if (!OVERWRITE) {
    try {
      await access(filePath);
      throw new Error(
        `File already exists: ${filePath}. Use --overwrite only if you intend to replace it.`
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  await writeFile(filePath, content, "utf8");
}

async function main() {
  assert(BATCH_ID, "Usage: node src/scripts/export-baseline.js <batchId> [YYYY-MM-DD] [--overwrite]");

  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(AS_OF_DATE),
    "As-of date must use YYYY-MM-DD format."
  );

  const batch = await prisma.pRBatch.findUnique({
    where: { id: BATCH_ID },
    include: {
      _count: {
        select: { lines: true, requests: true },
      },
    },
  });

  assert(batch, `Batch not found: ${BATCH_ID}`);

  console.log("\n========== BASELINE EXPORT ==========");
  console.log("Batch:", batch.fileName);
  console.log("Batch ID:", batch.id);
  console.log("PRs:", batch._count.requests);
  console.log("PR lines:", batch._count.lines);
  console.log("Preferred supplier as-of date:", AS_OF_DATE);

  const lines = await prisma.purchaseRequestLine.findMany({
    where: { batchId: BATCH_ID },
    include: {
      requirement: {
        include: {
          decision: {
            include: {
              policyVersion: {
                select: { version: true },
              },
              suggestions: {
                orderBy: { rank: "asc" },
                select: {
                  rank: true,
                  supplierId: true,
                },
              },
            },
          },
          purchaseOrderLine: {
            include: {
              purchaseOrder: {
                select: { poNumber: true },
              },
            },
          },
        },
      },
    },
    orderBy: [
      { prNumber: "asc" },
      { lineNumber: "asc" },
    ],
  });

  assert(
    lines.length === batch._count.lines,
    `Batch line count mismatch: expected ${batch._count.lines}, found ${lines.length}.`
  );

  const decisionRows = lines.map((line) => {
    const requirement = line.requirement;
    const decision = requirement?.decision;
    const suggestions = decision?.suggestions ?? [];

    return {
      pr_no: line.prNumber,
      pr_line: line.lineNumber,
      resolved_item_code:
        requirement?.itemCode || line.itemCode || "NEW",
      group_id: requirement?.groupCode || "",
      po_id:
        requirement?.purchaseOrderLine?.purchaseOrder?.poNumber || "",
      decision:
        decision?.decisionType === "PO"
          ? "PO"
          : decision?.decisionType === "SOURCING_REQUEST"
            ? "SOURCING_REQUEST"
            : "NOT_PROCESSED",
      route: decision?.route || "NOT_PROCESSED",
      supplier_id: decision?.supplierId || "",
      unit_price: decision?.unitPrice?.toString() || "",
      group_value_inr: requirement?.totalValue?.toString() || "",
      suggested_supplier_ids: suggestions
        .map((entry) => entry.supplierId)
        .join(";"),
      policy_version: decision?.policyVersion?.version || "",
      reason:
        decision?.reason ||
        (!line.plantCode && line.rawData?.plant
          ? `Unmapped plant code: ${line.rawData.plant}. Buyer mapping is required; no procurement action was created.`
          : "No requirement or procurement decision was created for this line."),
    };
  });

  const decisionHeaders = [
    "pr_no",
    "pr_line",
    "resolved_item_code",
    "group_id",
    "po_id",
    "decision",
    "route",
    "supplier_id",
    "unit_price",
    "group_value_inr",
    "suggested_supplier_ids",
    "policy_version",
    "reason",
  ];

  const processedCount = decisionRows.filter(
    (row) => row.decision !== "NOT_PROCESSED"
  ).length;

  const unprocessedCount = decisionRows.length - processedCount;

  const policyVersions = [
    ...new Set(
      decisionRows
        .map((row) => row.policy_version)
        .filter(Boolean)
    ),
  ];

  assert(
    policyVersions.length === 1,
    `Expected exactly one policy version in this batch; found: ${policyVersions.join(", ") || "none"}.`
  );

  const POLICY_VERSION = policyVersions[0];

  assert(
    processedCount + unprocessedCount === batch._count.lines,
    "Processed and unprocessed counts do not account for every source line."
  );

  assert(
    decisionRows.every(
      (row) =>
        row.decision === "NOT_PROCESSED" ||
        row.policy_version === POLICY_VERSION
    ),
    "Batch contains inconsistent policy versions."
  );

  console.log("Detected policy version:", POLICY_VERSION);

  const snapshotCutoff = new Date(`${AS_OF_DATE}T23:59:59.999Z`);

  const snapshots = await prisma.preferredSupplierSnapshot.findMany({
    where: {
      policyVersion: {
        version: POLICY_VERSION,
      },
      asOfDate: {
        lte: snapshotCutoff,
      },
    },
    include: {
      entries: {
        where: {
          rank: { lte: 3 },
        },
        orderBy: { rank: "asc" },
        select: {
          rank: true,
          supplierId: true,
          referencePrice: true,
        },
      },
    },
    orderBy: [
      { itemCode: "asc" },
      { asOfDate: "desc" },
    ],
  });

  // Keep the latest available snapshot per item on or before the requested date.
  const latestSnapshotByItem = new Map();

  for (const snapshot of snapshots) {
    if (!latestSnapshotByItem.has(snapshot.itemCode)) {
      latestSnapshotByItem.set(snapshot.itemCode, snapshot);
    }
  }

  const preferredRows = [];

  for (const [itemCode, snapshot] of latestSnapshotByItem) {
    for (const entry of snapshot.entries) {
      preferredRows.push({
        item_code: itemCode,
        rank: entry.rank,
        supplier_id: entry.supplierId,
        reference_price: entry.referencePrice?.toString() || "",
      });
    }
  }

  const preferredHeaders = [
    "item_code",
    "rank",
    "supplier_id",
    "reference_price",
  ];

  assert(preferredRows.length > 0, "No preferred supplier entries found for the selected date.");

  await mkdir(SUBMISSION_DIR, { recursive: true });

  const decisionPath = path.join(
    SUBMISSION_DIR,
    `decisions_v${POLICY_VERSION}.csv`
  );

  const preferredPath = path.join(
    SUBMISSION_DIR,
    `preferred_suppliers_v${POLICY_VERSION}_as_of_${AS_OF_DATE}.csv`
  );

  await writeExport(
    decisionPath,
    toCsv(decisionHeaders, decisionRows)
  );

  await writeExport(
    preferredPath,
    toCsv(preferredHeaders, preferredRows)
  );

  console.log("\n========== EXPORT VALIDATION ==========");
  console.log("Decision CSV rows:", decisionRows.length);
  console.log("Processed lines:", processedCount);
  console.log("Unprocessed lines:", unprocessedCount);
  console.log("Preferred items:", latestSnapshotByItem.size);
  console.log("Preferred supplier rows (top 3):", preferredRows.length);

  console.log("\n========== FILES CREATED ==========");
  console.log(decisionPath);
  console.log(preferredPath);
}

main()
  .catch((error) => {
    console.error("\nEXPORT FAILED:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
