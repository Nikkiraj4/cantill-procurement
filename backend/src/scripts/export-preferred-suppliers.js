import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = path.resolve(__dirname, "../../../");
const SUBMISSION_DIR = path.join(PROJECT_ROOT, "submission");

const AS_OF_DATE = process.argv[2] || "2026-11-18";
const DRY_RUN = process.argv.includes("--dry-run");
const OVERWRITE = process.argv.includes("--overwrite");

const LOOKBACK_548_DAYS = 548;

const WEIGHTS = {
  purchaseFrequency: 0.30,
  purchaseRecency: 0.25,
  contractHolding: 0.20,
  onTimeDelivery: 0.15,
  quality: 0.10,
};

const money = (value) => new Prisma.Decimal(value ?? 0);

const round = (value, digits = 4) =>
  Number(value.toFixed(digits));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function dateOnly(date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    )
  );
}

function daysBefore(date, days) {
  return new Date(date.getTime() - days * 86400000);
}

function daysBetween(earlier, later) {
  return Math.max(
    0,
    Math.floor((later.getTime() - earlier.getTime()) / 86400000)
  );
}

function csvCell(value) {
  if (value === null || value === undefined) return "";

  return `"${String(value).replaceAll('"', '""')}"`;
}

function toCsv(headers, rows) {
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvCell(row[header])).join(",")
    ),
  ].join("\n") + "\n";
}

function getReferencePrice(
  supplierId,
  itemCode,
  asOfDate,
  history,
  contracts
) {
  const cutoff = daysBefore(asOfDate, LOOKBACK_548_DAYS);

  const recentPOs = history
    .filter(
      (row) =>
        row.supplierId === supplierId &&
        row.itemCode === itemCode &&
        row.poDate >= cutoff &&
        row.poDate <= asOfDate
    )
    .sort((a, b) => b.poDate - a.poDate);

  if (recentPOs.length > 0) {
    return {
      price: money(recentPOs[0].unitPrice),
      source: "PURCHASE_HISTORY",
      reference: recentPOs[0].poNumber,
      date: recentPOs[0].poDate,
    };
  }

  const contractRates = contracts
    .filter(
      (contract) =>
        contract.supplierId === supplierId &&
        contract.startDate <= asOfDate
    )
    .flatMap((contract) =>
      contract.lines
        .filter((line) => line.itemCode === itemCode)
        .map((line) => ({
          contract,
          rate: line.rate,
        }))
    )
    .sort(
      (a, b) =>
        b.contract.startDate.getTime() -
        a.contract.startDate.getTime()
    );

  if (contractRates.length > 0) {
    const selected = contractRates[0];

    return {
      price: money(selected.rate),
      source: "CONTRACT_RATE",
      reference: selected.contract.id,
      date: selected.contract.startDate,
    };
  }

  return {
    price: null,
    source: null,
    reference: null,
    date: null,
  };
}

function buildPreferredSuppliers({
  item,
  asOfDate,
  suppliers,
  history,
  contracts,
}) {
  const cutoff = daysBefore(asOfDate, LOOKBACK_548_DAYS);
  const eligible = [];

  for (const supplier of suppliers) {
    if (supplier.status !== "ACTIVE") continue;

    const supplierHistory = history.filter(
      (row) =>
        row.supplierId === supplier.id &&
        row.itemCode === item.code &&
        row.poDate >= cutoff &&
        row.poDate <= asOfDate
    );

    const eligibleContracts = contracts.filter(
      (contract) =>
        contract.supplierId === supplier.id &&
        contract.startDate <= asOfDate &&
        contract.lines.some((line) => line.itemCode === item.code)
    );

    if (
      supplierHistory.length === 0 &&
      eligibleContracts.length === 0
    ) {
      continue;
    }

    const latestPO = supplierHistory
      .slice()
      .sort((a, b) => b.poDate - a.poDate)[0];

    const frequency = supplierHistory.length;

    const daysSinceLastPurchase = latestPO
      ? daysBetween(latestPO.poDate, asOfDate)
      : null;

    const recencyScore =
      daysSinceLastPurchase === null
        ? 0
        : Math.max(
            0,
            100 *
              (1 - daysSinceLastPurchase / LOOKBACK_548_DAYS)
          );

    const referencePrice = getReferencePrice(
      supplier.id,
      item.code,
      asOfDate,
      history,
      contracts
    );

    eligible.push({
      supplier,
      frequency,
      recencyScore,
      hasContract: eligibleContracts.length > 0,
      referencePrice,
    });
  }

  const maximumFrequency = Math.max(
    1,
    ...eligible.map((entry) => entry.frequency)
  );

  const ranked = eligible.map((entry) => {
    const frequencyScore =
      (entry.frequency / maximumFrequency) * 100;

    const contractScore = entry.hasContract ? 100 : 0;

    const onTimeScore = Math.max(
      0,
      Math.min(
        100,
        Number(entry.supplier.onTimePct ?? 0)
      )
    );

    const qualityScore = Math.max(
      0,
      Math.min(
        100,
        Number(entry.supplier.qualityRating ?? 0) * 20
      )
    );

    const score =
      frequencyScore * WEIGHTS.purchaseFrequency +
      entry.recencyScore * WEIGHTS.purchaseRecency +
      contractScore * WEIGHTS.contractHolding +
      onTimeScore * WEIGHTS.onTimeDelivery +
      qualityScore * WEIGHTS.quality;

    return {
      supplierId: entry.supplier.id,
      score: round(score),
      referencePrice: entry.referencePrice.price,
    };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.supplierId.localeCompare(b.supplierId)
  );

  return ranked;
}

async function main() {
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(AS_OF_DATE),
    "As-of date must use YYYY-MM-DD format."
  );

  const parsedDate = new Date(`${AS_OF_DATE}T00:00:00.000Z`);

  assert(
    !Number.isNaN(parsedDate.getTime()) &&
      parsedDate.toISOString().slice(0, 10) === AS_OF_DATE,
    "Invalid as-of date."
  );

  const asOfDate = dateOnly(parsedDate);
  const cutoff = daysBefore(asOfDate, LOOKBACK_548_DAYS);

  console.log("\n========== PREFERRED SUPPLIER EXPORT ==========");
  console.log("As-of date:", AS_OF_DATE);
  console.log("Lookback:", LOOKBACK_548_DAYS, "days");
  console.log("Top suppliers per item: 3");
  console.log("Dry run:", DRY_RUN);

  const [items, suppliers, history, contracts] =
    await Promise.all([
      prisma.item.findMany({
        select: {
          code: true,
          description: true,
        },
        orderBy: { code: "asc" },
      }),

      prisma.supplier.findMany({
        select: {
          id: true,
          status: true,
          onTimePct: true,
          qualityRating: true,
        },
      }),

      prisma.purchaseHistory.findMany({
        where: {
          poDate: {
            gte: cutoff,
            lte: asOfDate,
          },
        },
        select: {
          poNumber: true,
          poDate: true,
          supplierId: true,
          itemCode: true,
          unitPrice: true,
        },
      }),

      prisma.contract.findMany({
        where: {
          startDate: {
            lte: asOfDate,
          },
        },
        include: {
          lines: {
            select: {
              itemCode: true,
              rate: true,
            },
          },
        },
      }),
    ]);

  assert(items.length > 0, "No item-master records found.");

  const rows = [];
  let itemsWithSuppliers = 0;
  let itemsWithoutSuppliers = 0;

  for (const item of items) {
    const ranked = buildPreferredSuppliers({
      item,
      asOfDate,
      suppliers,
      history,
      contracts,
    }).slice(0, 3);

    if (ranked.length === 0) {
      itemsWithoutSuppliers += 1;

      rows.push({
        item_code: item.code,
        rank: "",
        supplier_id: "",
        reference_price: "",
      });

      continue;
    }

    itemsWithSuppliers += 1;

    for (let index = 0; index < ranked.length; index += 1) {
      const entry = ranked[index];

      rows.push({
        item_code: item.code,
        rank: index + 1,
        supplier_id: entry.supplierId,
        reference_price:
          entry.referencePrice?.toString() ?? "",
      });
    }
  }

  const headers = [
    "item_code",
    "rank",
    "supplier_id",
    "reference_price",
  ];

  const outputPath = path.join(
    SUBMISSION_DIR,
    `preferred_suppliers_as_of_${AS_OF_DATE}.csv`
  );

  console.log("\n========== VALIDATION ==========");
  console.log("Item master records:", items.length);
  console.log("Active suppliers:", suppliers.filter(
    (supplier) => supplier.status === "ACTIVE"
  ).length);
  console.log("Relevant PO-history rows:", history.length);
  console.log("Eligible contracts loaded:", contracts.length);
  console.log("Items with preferred suppliers:", itemsWithSuppliers);
  console.log("Items without eligible suppliers:", itemsWithoutSuppliers);
  console.log("Preferred supplier rows:", rows.length);

  assert(
    itemsWithSuppliers + itemsWithoutSuppliers === items.length,
    "Not every item was processed."
  );

  assert(
    rows.every((row) => row.item_code),
    "An export row is missing its item code."
  );

  if (DRY_RUN) {
    console.log("\nDRY RUN: No CSV file was written.");
    console.log("Output would be:", outputPath);
    return;
  }

  await mkdir(SUBMISSION_DIR, { recursive: true });

  if (!OVERWRITE) {
    try {
      await access(outputPath);
      throw new Error(
        `File already exists: ${outputPath}. Use --overwrite to replace it.`
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  await writeFile(outputPath, toCsv(headers, rows), "utf8");

  console.log("\n========== FILE CREATED ==========");
  console.log(outputPath);
}

main()
  .catch((error) => {
    console.error("\nPREFERRED SUPPLIER EXPORT FAILED:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
