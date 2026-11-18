
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parse } from "csv-parse/sync";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_FILE = path.resolve(
  __dirname,
  "../../../data/source/pr_batches/sample_pr_batch.csv"
);

const DRY_RUN = process.argv.includes("--dry-run");

const EXPECTED_COLUMNS = [
  "pr_no",
  "pr_line",
  "created_at",
  "requester",
  "department",
  "plant",
  "item_code",
  "description",
  "quantity",
  "uom",
  "estimated_unit_price",
  "need_by_date",
  "urgency",
];

function required(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`Row ${rowNumber}: ${field} is required.`);
  }

  return normalized;
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function decimal(value, field, rowNumber, allowZero = true) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`Row ${rowNumber}: ${field} is required.`);
  }

  const number = Number(normalized);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    (!allowZero && number === 0)
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}: "${value}".`);
  }

  return new Prisma.Decimal(normalized);
}

function optionalDecimal(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  return decimal(normalized, field, rowNumber);
}

function dateTime(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    throw new Error(
      `Row ${rowNumber}: ${field} must use YYYY-MM-DD HH:mm format.`
    );
  }

  const date = new Date(`${normalized.replace(" ", "T")}:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 16).replace("T", " ") !== normalized
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}: "${value}".`);
  }

  return date;
}

function dateOnly(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(
      `Row ${rowNumber}: ${field} must use YYYY-MM-DD format.`
    );
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}: "${value}".`);
  }

  return date;
}

function readSourceFile() {
  const content = readFileSync(SOURCE_FILE);

  const checksum = createHash("sha256")
    .update(content)
    .digest("hex");

  const rows = parse(content.toString("utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  const actualColumns = Object.keys(rows[0] ?? {});

  if (
    EXPECTED_COLUMNS.length !== actualColumns.length ||
    EXPECTED_COLUMNS.some((column) => !actualColumns.includes(column))
  ) {
    throw new Error(
      `Unexpected CSV columns.\nExpected: ${EXPECTED_COLUMNS.join(", ")}\n` +
        `Received: ${actualColumns.join(", ")}`
    );
  }

  return { rows, checksum };
}

function prepareRows(sourceRows, plantCodes, itemCodes) {
  const errors = [];
  const preparedRows = [];
  const lineKeys = new Set();
  const unmappedPlants = new Set();

  let zeroQuantityCount = 0;
  let blankItemCodeCount = 0;
  let blankPriceCount = 0;

  for (const [index, row] of sourceRows.entries()) {
    const rowNumber = index + 2;

    try {
      const prNumber = required(row.pr_no, "pr_no", rowNumber);
      const lineNumber = required(row.pr_line, "pr_line", rowNumber);

      const lineKey = `${prNumber}::${lineNumber}`;

      if (lineKeys.has(lineKey)) {
        throw new Error(
          `Row ${rowNumber}: duplicate PR number and line number (${lineKey}).`
        );
      }

      lineKeys.add(lineKey);

      const createdAt = dateTime(
        row.created_at,
        "created_at",
        rowNumber
      );

      const requester = required(
        row.requester,
        "requester",
        rowNumber
      );

      const department = optionalText(row.department);
      const sourcePlant = required(row.plant, "plant", rowNumber);
      const sourceItemCode = optionalText(row.item_code);

      const description = required(
        row.description,
        "description",
        rowNumber
      );

      const quantity = decimal(
        row.quantity,
        "quantity",
        rowNumber
      );

      const uom = required(row.uom, "uom", rowNumber);

      const estimatedUnitPrice = optionalDecimal(
        row.estimated_unit_price,
        "estimated_unit_price",
        rowNumber
      );

      const needByDate = dateOnly(
        row.need_by_date,
        "need_by_date",
        rowNumber
      );

      const urgency = required(
        row.urgency,
        "urgency",
        rowNumber
      );

      if (sourceItemCode && !itemCodes.has(sourceItemCode)) {
        throw new Error(
          `Row ${rowNumber}: unknown item code "${sourceItemCode}".`
        );
      }

      if (!plantCodes.has(sourcePlant)) {
        unmappedPlants.add(sourcePlant);
      }

      if (quantity.isZero()) {
        zeroQuantityCount += 1;
      }

      if (!sourceItemCode) {
        blankItemCodeCount += 1;
      }

      if (!estimatedUnitPrice) {
        blankPriceCount += 1;
      }

      preparedRows.push({
        prNumber,
        lineNumber,
        createdAt,
        requester,
        department,
        sourcePlant,
        plantCode: plantCodes.has(sourcePlant) ? sourcePlant : null,
        itemCode: sourceItemCode,
        description,
        quantity,
        uom,
        estimatedUnitPrice,
        needByDate,
        urgency,
        rawData: { ...row },
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `PR batch validation failed:\n${errors.slice(0, 30).join("\n")}` +
        (errors.length > 30
          ? `\n...and ${errors.length - 30} more errors.`
          : "")
    );
  }

  return {
    rows: preparedRows,
    unmappedPlants: [...unmappedPlants],
    zeroQuantityCount,
    blankItemCodeCount,
    blankPriceCount,
  };
}

function groupRequests(lines) {
  const groups = new Map();

  for (const line of lines) {
    if (!groups.has(line.prNumber)) {
      groups.set(line.prNumber, []);
    }

    groups.get(line.prNumber).push(line);
  }

  return groups;
}

function requestHeader(prNumber, lines) {
  const firstLine = lines[0];

  const departments = new Set(
    lines.map((line) => line.department ?? "")
  );

  const department =
    departments.size === 1
      ? firstLine.department
      : null;

  return {
    prNumber,
    createdAt: firstLine.createdAt,
    requester: firstLine.requester,
    department,
  };
}

async function main() {
  console.log("Cantill procurement — PR batch import");
  console.log("--------------------------------------");

  const { rows: sourceRows, checksum } = readSourceFile();

  console.log(`Source file: ${SOURCE_FILE}`);
  console.log(`SHA-256: ${checksum}`);
  console.log(`Source rows: ${sourceRows.length}`);

  const existingBatch = await prisma.pRBatch.findFirst({
    where: { fileChecksum: checksum },
    select: {
      id: true,
      fileName: true,
      rowCount: true,
    },
  });

  if (existingBatch) {
    console.log("\nThis exact file has already been imported.");
    console.log(`Existing batch ID: ${existingBatch.id}`);
    console.log(`Existing row count: ${existingBatch.rowCount}`);
    console.log("Skipping import to prevent duplicates.");
    return;
  }

  const [plants, items] = await Promise.all([
    prisma.plant.findMany({ select: { code: true } }),
    prisma.item.findMany({ select: { code: true } }),
  ]);

  const plantCodes = new Set(plants.map((plant) => plant.code));
  const itemCodes = new Set(items.map((item) => item.code));

  const prepared = prepareRows(sourceRows, plantCodes, itemCodes);
  const requests = groupRequests(prepared.rows);

  console.log("\nValidation successful.");
  console.log(`PR headers: ${requests.size}`);
  console.log(`PR lines: ${prepared.rows.length}`);
  console.log(`Zero-quantity lines: ${prepared.zeroQuantityCount}`);
  console.log(`Blank item codes: ${prepared.blankItemCodeCount}`);
  console.log(`Blank estimated prices: ${prepared.blankPriceCount}`);

  if (prepared.unmappedPlants.length > 0) {
    console.log(
      `Unmapped plant codes: ${prepared.unmappedPlants.join(", ")}`
    );
    console.log(
      "These source plant codes will be preserved in rawData; plantCode will be null."
    );
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN complete. No database records were created.");
    return;
  }

  console.log("\nStarting database transaction...");

  const result = await prisma.$transaction(
    async (tx) => {
      const batch = await tx.pRBatch.create({
        data: {
          fileName: path.basename(SOURCE_FILE),
          fileChecksum: checksum,
          status: "IMPORTED",
          rowCount: prepared.rows.length,
        },
      });

      const requestIds = new Map();

      for (const [prNumber, lines] of requests) {
        const header = requestHeader(prNumber, lines);

        const request = await tx.purchaseRequest.create({
          data: {
            batchId: batch.id,
            ...header,
          },
        });

        requestIds.set(prNumber, request.id);
      }

      for (const line of prepared.rows) {
        await tx.purchaseRequestLine.create({
          data: {
            batchId: batch.id,
            requestId: requestIds.get(line.prNumber),
            prNumber: line.prNumber,
            lineNumber: line.lineNumber,
            plantCode: line.plantCode,
            itemCode: line.itemCode,
            description: line.description,
            quantity: line.quantity,
            uom: line.uom,
            estimatedUnitPrice: line.estimatedUnitPrice,
            needByDate: line.needByDate,
            urgency: line.urgency,
            rawData: line.rawData,
          },
        });
      }

      return {
        batchId: batch.id,
        requestCount: requests.size,
        lineCount: prepared.rows.length,
      };
    },
    {
      maxWait: 10000,
      timeout: 60000,
    }
  );

  console.log("\nPR batch import completed successfully.");
  console.log(`Batch ID: ${result.batchId}`);
  console.log(`PR headers imported: ${result.requestCount}`);
  console.log(`PR lines imported: ${result.lineCount}`);
  console.log("All records were committed to PostgreSQL.");
}

main()
  .catch((error) => {
    console.error("\nPR batch import failed.");
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
