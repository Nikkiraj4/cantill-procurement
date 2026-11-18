
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parse } from "csv-parse/sync";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, "../../../data/source");

const FILES = {
  plants: path.join(SOURCE_DIR, "master_data/plants.csv"),
  items: path.join(SOURCE_DIR, "master_data/item_master.csv"),
  suppliers: path.join(SOURCE_DIR, "master_data/supplier_master.csv"),
  purchaseHistory: path.join(SOURCE_DIR, "master_data/po_history.csv"),
  contractRegister: path.join(SOURCE_DIR, "contracts/contract_register.csv"),
  contractLines: path.join(SOURCE_DIR, "contracts/contract_lines.csv"),
};

function readCsv(filePath) {
  const content = readFileSync(filePath, "utf8");

  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
}

function required(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`Row ${rowNumber}: ${field} is required.`);
  }

  return normalized;
}

function decimal(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();
  const number = Number(normalized);

  if (!normalized || !Number.isFinite(number)) {
    throw new Error(`Row ${rowNumber}: invalid ${field}: "${value}".`);
  }

  return new Prisma.Decimal(normalized);
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

function optionalNumber(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    throw new Error(`Row ${rowNumber}: invalid ${field}: "${value}".`);
  }

  return new Prisma.Decimal(normalized);
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function optionalBoolean(value, field, rowNumber) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new Error(
    `Row ${rowNumber}: invalid ${field}: "${value}". Expected True or False.`
  );
}

function categoriesFrom(value) {
  return [...new Set(
    String(value ?? "")
      .split(/[;|]/)
      .map((category) => category.trim())
      .filter(Boolean)
  )];
}

function deterministicId(row, index) {
  const hash = createHash("sha256")
    .update(`${index}:${JSON.stringify(row)}`)
    .digest("hex");

  return `ph_${hash.slice(0, 32)}`;
}

function validateReferences(data) {
  const errors = [];

  const plantCodes = new Set(data.plants.map((row) => row.plant));
  const itemCodes = new Set(data.items.map((row) => row.item_code));
  const supplierIds = new Set(data.suppliers.map((row) => row.supplier_id));
  const contractIds = new Set(
    data.contractRegister.map((row) => row.contract_id)
  );

  data.purchaseHistory.forEach((row, index) => {
    const rowNumber = index + 2;

    if (!supplierIds.has(row.supplier_id)) {
      errors.push(
        `PO history row ${rowNumber}: unknown supplier ${row.supplier_id}`
      );
    }

    if (!itemCodes.has(row.item_code)) {
      errors.push(
        `PO history row ${rowNumber}: unknown item ${row.item_code}`
      );
    }

    if (!plantCodes.has(row.plant)) {
      errors.push(
        `PO history row ${rowNumber}: unknown plant ${row.plant}`
      );
    }
  });

  data.contractRegister.forEach((row, index) => {
    if (!supplierIds.has(row.supplier_id)) {
      errors.push(
        `Contract register row ${index + 2}: unknown supplier ${row.supplier_id}`
      );
    }
  });

  data.contractLines.forEach((row, index) => {
    const rowNumber = index + 2;

    if (!contractIds.has(row.contract_id)) {
      errors.push(
        `Contract line row ${rowNumber}: unknown contract ${row.contract_id}`
      );
    }

    if (!itemCodes.has(row.item_code)) {
      errors.push(
        `Contract line row ${rowNumber}: unknown item ${row.item_code}`
      );
    }
  });

  if (errors.length > 0) {
    throw new Error(
      `Reference validation failed:\n${errors.slice(0, 30).join("\n")}` +
        (errors.length > 30 ? `\n...and ${errors.length - 30} more errors.` : "")
    );
  }
}

function prepareData() {
  const data = {
    plants: readCsv(FILES.plants),
    items: readCsv(FILES.items),
    suppliers: readCsv(FILES.suppliers),
    purchaseHistory: readCsv(FILES.purchaseHistory),
    contractRegister: readCsv(FILES.contractRegister),
    contractLines: readCsv(FILES.contractLines),
  };

  validateReferences(data);

  return data;
}

async function importPlants(tx, rows) {
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const code = required(row.plant, "plant", rowNumber);
    const name = required(row.name, "name", rowNumber);

    await tx.plant.upsert({
      where: { code },
      create: { code, name },
      update: { name },
    });
  }

  return rows.length;
}

async function importItems(tx, rows) {
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const code = required(row.item_code, "item_code", rowNumber);

    await tx.item.upsert({
      where: { code },
      create: {
        code,
        description: required(row.description, "description", rowNumber),
        uom: required(row.uom, "uom", rowNumber),
        category: required(row.category, "category", rowNumber),
        itemType: required(row.item_type, "item_type", rowNumber).toUpperCase(),
        standardPrice: decimal(
          row.standard_price,
          "standard_price",
          rowNumber
        ),
      },
      update: {
        description: required(row.description, "description", rowNumber),
        uom: required(row.uom, "uom", rowNumber),
        category: required(row.category, "category", rowNumber),
        itemType: required(row.item_type, "item_type", rowNumber).toUpperCase(),
        standardPrice: decimal(
          row.standard_price,
          "standard_price",
          rowNumber
        ),
      },
    });
  }

  return rows.length;
}

async function importSuppliers(tx, rows) {
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const id = required(row.supplier_id, "supplier_id", rowNumber);

    await tx.supplier.upsert({
      where: { id },
      create: {
        id,
        name: required(row.name, "name", rowNumber),
        city: optionalText(row.city),
        status: required(row.status, "status", rowNumber).toUpperCase(),
        onTimePct: optionalNumber(row.on_time_pct, "on_time_pct", rowNumber),
        qualityRating: optionalNumber(
          row.quality_rating,
          "quality_rating",
          rowNumber
        ),
      },
      update: {
        name: required(row.name, "name", rowNumber),
        city: optionalText(row.city),
        status: required(row.status, "status", rowNumber).toUpperCase(),
        onTimePct: optionalNumber(row.on_time_pct, "on_time_pct", rowNumber),
        qualityRating: optionalNumber(
          row.quality_rating,
          "quality_rating",
          rowNumber
        ),
      },
    });

    const categories = categoriesFrom(row.categories);

    await tx.supplierCategory.deleteMany({
      where: { supplierId: id },
    });

    if (categories.length > 0) {
      await tx.supplierCategory.createMany({
        data: categories.map((category) => ({
          supplierId: id,
          category,
        })),
        skipDuplicates: true,
      });
    }
  }

  return rows.length;
}

async function importPurchaseHistory(tx, rows) {
  const records = rows.map((row, index) => {
    const rowNumber = index + 2;

    return {
      id: deterministicId(row, index),
      poNumber: required(row.po_number, "po_number", rowNumber),
      poDate: dateOnly(row.po_date, "po_date", rowNumber),
      supplierId: required(row.supplier_id, "supplier_id", rowNumber),
      itemCode: required(row.item_code, "item_code", rowNumber),
      quantity: decimal(row.quantity, "quantity", rowNumber),
      uom: required(row.uom, "uom", rowNumber),
      unitPrice: decimal(row.unit_price, "unit_price", rowNumber),
      plantCode: required(row.plant, "plant", rowNumber),
      deliveredOnTime: optionalBoolean(
        row.delivered_on_time,
        "delivered_on_time",
        rowNumber
      ),
    };
  });

  // The source CSV is authoritative: replace its imported history on each run.
  await tx.purchaseHistory.deleteMany();

  if (records.length > 0) {
    await tx.purchaseHistory.createMany({
      data: records,
    });
  }

  return records.length;
}

async function importContracts(tx, registerRows, lineRows) {
  for (const [index, row] of registerRows.entries()) {
    const rowNumber = index + 2;
    const id = required(row.contract_id, "contract_id", rowNumber);

    await tx.contract.upsert({
      where: { id },
      create: {
        id,
        supplierId: required(row.supplier_id, "supplier_id", rowNumber),
        supplierName: required(row.supplier_name, "supplier_name", rowNumber),
        startDate: dateOnly(row.start_date, "start_date", rowNumber),
        endDate: dateOnly(row.end_date, "end_date", rowNumber),
        valueCap: decimal(row.value_cap, "value_cap", rowNumber),
        consumedValue: decimal(
          row.consumed_value,
          "consumed_value",
          rowNumber
        ),
        source: "REGISTER",
      },
      update: {
        supplierId: required(row.supplier_id, "supplier_id", rowNumber),
        supplierName: required(row.supplier_name, "supplier_name", rowNumber),
        startDate: dateOnly(row.start_date, "start_date", rowNumber),
        endDate: dateOnly(row.end_date, "end_date", rowNumber),
        valueCap: decimal(row.value_cap, "value_cap", rowNumber),
        consumedValue: decimal(
          row.consumed_value,
          "consumed_value",
          rowNumber
        ),
        source: "REGISTER",
      },
    });
  }

  for (const [index, row] of lineRows.entries()) {
    const rowNumber = index + 2;
    const contractId = required(row.contract_id, "contract_id", rowNumber);
    const itemCode = required(row.item_code, "item_code", rowNumber);

    await tx.contractLine.upsert({
      where: {
        contractId_itemCode: {
          contractId,
          itemCode,
        },
      },
      create: {
        contractId,
        itemCode,
        description: required(row.description, "description", rowNumber),
        uom: required(row.uom, "uom", rowNumber),
        rate: decimal(row.rate, "rate", rowNumber),
      },
      update: {
        description: required(row.description, "description", rowNumber),
        uom: required(row.uom, "uom", rowNumber),
        rate: decimal(row.rate, "rate", rowNumber),
      },
    });
  }

  return {
    contracts: registerRows.length,
    contractLines: lineRows.length,
  };
}

async function main() {
  console.log("\nCantill procurement — master-data import");
  console.log("-----------------------------------------");

  const data = prepareData();

  console.log("CSV files loaded and references validated.");
  console.log("Starting database transaction...\n");

  const report = await prisma.$transaction(
    async (tx) => {
      const plants = await importPlants(tx, data.plants);
      const items = await importItems(tx, data.items);
      const suppliers = await importSuppliers(tx, data.suppliers);
      const purchaseHistory = await importPurchaseHistory(
        tx,
        data.purchaseHistory
      );

      const contracts = await importContracts(
        tx,
        data.contractRegister,
        data.contractLines
      );

      return {
        plants,
        items,
        suppliers,
        purchaseHistory,
        ...contracts,
      };
    },
    {
      maxWait: 10000,
      timeout: 120000,
    }
  );

  console.log("Import completed successfully.\n");
  console.table(report);
  console.log("All imported records were committed to PostgreSQL.");
}

main()
  .catch((error) => {
    console.error("\nMaster-data import failed:");
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
