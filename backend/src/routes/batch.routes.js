
import { Router } from "express";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Prisma } from "@prisma/client";

const router = Router();

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
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Row ${rowNumber}: ${field} is required.`);
  return result;
}

function optionalText(value) {
  return String(value ?? "").trim() || null;
}

function decimal(value, field, rowNumber, allowZero = true) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Row ${rowNumber}: ${field} is required.`);

  const number = Number(result);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    (!allowZero && number === 0)
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}.`);
  }

  return new Prisma.Decimal(result);
}

function dateTime(value, field, rowNumber) {
  const result = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(result)) {
    throw new Error(`Row ${rowNumber}: invalid ${field} format.`);
  }

  const date = new Date(`${result.replace(" ", "T")}:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 16).replace("T", " ") !== result
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}.`);
  }

  return date;
}

function dateOnly(value, field, rowNumber) {
  const result = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error(`Row ${rowNumber}: invalid ${field} format.`);
  }

  const date = new Date(`${result}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== result
  ) {
    throw new Error(`Row ${rowNumber}: invalid ${field}.`);
  }

  return date;
}

function prepareRows(rows, plantCodes, itemCodes) {
  const prepared = [];
  const errors = [];
  const lineKeys = new Set();
  const unmappedPlants = new Set();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;

    try {
      const prNumber = required(row.pr_no, "pr_no", rowNumber);
      const lineNumber = required(row.pr_line, "pr_line", rowNumber);
      const key = `${prNumber}::${lineNumber}`;

      if (lineKeys.has(key)) {
        throw new Error(`Row ${rowNumber}: duplicate PR line ${key}.`);
      }
      lineKeys.add(key);

      const sourcePlant = required(row.plant, "plant", rowNumber);
      const itemCode = optionalText(row.item_code);

      if (itemCode && !itemCodes.has(itemCode)) {
        throw new Error(`Row ${rowNumber}: unknown item code "${itemCode}".`);
      }

      if (!plantCodes.has(sourcePlant)) unmappedPlants.add(sourcePlant);

      prepared.push({
        prNumber,
        lineNumber,
        createdAt: dateTime(row.created_at, "created_at", rowNumber),
        requester: required(row.requester, "requester", rowNumber),
        department: optionalText(row.department),
        plantCode: plantCodes.has(sourcePlant) ? sourcePlant : null,
        itemCode,
        description: required(row.description, "description", rowNumber),
        quantity: decimal(row.quantity, "quantity", rowNumber),
        uom: required(row.uom, "uom", rowNumber),
        estimatedUnitPrice: row.estimated_unit_price?.trim()
          ? decimal(row.estimated_unit_price, "estimated_unit_price", rowNumber)
          : null,
        needByDate: dateOnly(row.need_by_date, "need_by_date", rowNumber),
        urgency: required(row.urgency, "urgency", rowNumber),
        rawData: { ...row, plant: sourcePlant },
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length) {
    throw new Error(
      `CSV validation failed:\n${errors.slice(0, 30).join("\n")}`
    );
  }

  return { rows: prepared, unmappedPlants: [...unmappedPlants] };
}

function groupRequests(lines) {
  const groups = new Map();

  for (const line of lines) {
    if (!groups.has(line.prNumber)) groups.set(line.prNumber, []);
    groups.get(line.prNumber).push(line);
  }

  return groups;
}

export async function importBatchCsv(req, res, prisma) {
  router.prisma = prisma;
  try {
    if (typeof req.body !== "string" || !req.body.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please upload a non-empty CSV file.",
      });
    }

    const fileName = String(req.headers["x-file-name"] || "purchase-requests.csv")
      .replace(/[\\/]/g, "_")
      .slice(0, 255);

    if (!fileName.toLowerCase().endsWith(".csv")) {
      return res.status(400).json({
        success: false,
        message: "Only CSV files are supported.",
      });
    }

    const content = req.body;
    const checksum = createHash("sha256").update(content).digest("hex");

    const existing = await router.prisma.pRBatch.findFirst({
      where: { fileChecksum: checksum },
      select: { id: true, fileName: true, rowCount: true },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This exact CSV file has already been imported.",
        existingBatch: existing,
      });
    }

    const sourceRows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });

    if (!sourceRows.length) {
      return res.status(400).json({
        success: false,
        message: "The CSV contains no data rows.",
      });
    }

    const actualColumns = Object.keys(sourceRows[0]);

    if (
      EXPECTED_COLUMNS.length !== actualColumns.length ||
      EXPECTED_COLUMNS.some((column) => !actualColumns.includes(column))
    ) {
      return res.status(400).json({
        success: false,
        message: "The CSV columns do not match the required PR batch format.",
        expectedColumns: EXPECTED_COLUMNS,
        receivedColumns: actualColumns,
      });
    }

    const [plants, items] = await Promise.all([
      router.prisma.plant.findMany({ select: { code: true } }),
      router.prisma.item.findMany({ select: { code: true } }),
    ]);

    const prepared = prepareRows(
      sourceRows,
      new Set(plants.map((plant) => plant.code)),
      new Set(items.map((item) => item.code))
    );

    const requests = groupRequests(prepared.rows);

    const result = await router.prisma.$transaction(
      async (tx) => {
        const batch = await tx.pRBatch.create({
          data: {
            fileName,
            fileChecksum: checksum,
            status: "IMPORTED",
            rowCount: prepared.rows.length,
          },
        });

        const requestIds = new Map();

        for (const [prNumber, lines] of requests) {
          const firstLine = lines[0];
          const departments = new Set(
            lines.map((line) => line.department ?? "")
          );

          const request = await tx.purchaseRequest.create({
            data: {
              batchId: batch.id,
              prNumber,
              createdAt: firstLine.createdAt,
              requester: firstLine.requester,
              department:
                departments.size === 1 ? firstLine.department : null,
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
          fileName,
          requestCount: requests.size,
          lineCount: prepared.rows.length,
        };
      },
      { maxWait: 10000, timeout: 60000 }
    );

    return res.status(201).json({
      success: true,
      message: "PR batch imported successfully.",
      data: {
        ...result,
        unmappedPlants: prepared.unmappedPlants,
      },
    });
  } catch (error) {
    console.error("PR batch upload failed:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Unable to import the CSV file.",
    });
  }
}

export function createBatchRouter(prisma) {
  router.prisma = prisma;
  router.post("/upload", (req, res) => importBatchCsv(req, res, prisma));
  router.prisma = prisma;
  return router;
}
