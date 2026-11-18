import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PDF_DIR = path.resolve(
  __dirname,
  "../../../data/source/contracts/pdf"
);

const SIGNED_CONTRACTS = [
  {
    id: "RC-2026-031",
    supplierId: "S021",
    supplierName: "Pneumatic Point",
    startDate: "2026-11-15",
    endDate: "2027-11-14",
    signedDate: "2026-11-15",
    valueCap: "2000000.00",
    sourceFileName: "RC-2026-031.pdf",
    lines: [
      {
        itemCode: "ITM-1036",
        description: "Pneumatic cylinder 50x100",
        uom: "NOS",
        rate: "3537.76",
      },
      {
        itemCode: "ITM-1037",
        description: "Solenoid valve 5/2 1/4 inch",
        uom: "NOS",
        rate: "2439.01",
      },
      {
        itemCode: "ITM-1039",
        description: "FRL unit 1/2 inch",
        uom: "NOS",
        rate: "2746.87",
      },
    ],
  },
  {
    id: "RC-2026-033",
    supplierId: "S035",
    supplierName: "Infoline Systems",
    startDate: "2026-11-20",
    endDate: "2027-11-19",
    signedDate: "2026-11-20",
    valueCap: "5000000.00",
    sourceFileName: "RC-2026-033.pdf",
    lines: [
      {
        itemCode: "ITM-1056",
        description: "Laptop i5 16GB 512GB",
        uom: "NOS",
        rate: "64654.36",
      },
      {
        itemCode: "ITM-1057",
        description: "24 inch monitor",
        uom: "NOS",
        rate: "10689.51",
      },
    ],
  },
];

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return date;
}

function decimal(value) {
  return new Prisma.Decimal(value);
}

async function validateReferences(tx) {
  const supplierIds = [
    ...new Set(SIGNED_CONTRACTS.map((contract) => contract.supplierId)),
  ];

  const itemCodes = [
    ...new Set(
      SIGNED_CONTRACTS.flatMap((contract) =>
        contract.lines.map((line) => line.itemCode)
      )
    ),
  ];

  const suppliers = await tx.supplier.findMany({
    where: { id: { in: supplierIds } },
    select: { id: true, name: true, status: true },
  });

  const items = await tx.item.findMany({
    where: { code: { in: itemCodes } },
    select: { code: true },
  });

  const supplierMap = new Map(
    suppliers.map((supplier) => [supplier.id, supplier])
  );
  const itemSet = new Set(items.map((item) => item.code));

  for (const contract of SIGNED_CONTRACTS) {
    const supplier = supplierMap.get(contract.supplierId);

    if (!supplier) {
      throw new Error(
        `${contract.id}: supplier ${contract.supplierId} does not exist.`
      );
    }

    if (supplier.name !== contract.supplierName) {
      throw new Error(
        `${contract.id}: supplier name mismatch. ` +
          `Expected "${contract.supplierName}", found "${supplier.name}".`
      );
    }

    if (supplier.status.toLowerCase() !== "active") {
      throw new Error(
        `${contract.id}: supplier ${supplier.id} is not Active.`
      );
    }

    if (!existsSync(path.join(PDF_DIR, contract.sourceFileName))) {
      throw new Error(
        `${contract.id}: source PDF is missing: ${contract.sourceFileName}`
      );
    }

    for (const line of contract.lines) {
      if (!itemSet.has(line.itemCode)) {
        throw new Error(
          `${contract.id}: unknown item code ${line.itemCode}.`
        );
      }
    }

    if (dateOnly(contract.startDate) > dateOnly(contract.endDate)) {
      throw new Error(`${contract.id}: start date is after end date.`);
    }
  }

  const existingContracts = await tx.contract.findMany({
    where: {
      id: { in: SIGNED_CONTRACTS.map((contract) => contract.id) },
    },
    select: { id: true, source: true },
  });

  for (const existing of existingContracts) {
    if (existing.source !== "SIGNED_PDF") {
      throw new Error(
        `${existing.id} already exists with source ${existing.source}. ` +
          "Refusing to overwrite a registered contract."
      );
    }
  }
}

async function importSignedContracts(tx) {
  let importedLines = 0;

  for (const contract of SIGNED_CONTRACTS) {
    await tx.contract.upsert({
      where: { id: contract.id },
      create: {
        id: contract.id,
        supplierId: contract.supplierId,
        supplierName: contract.supplierName,
        startDate: dateOnly(contract.startDate),
        endDate: dateOnly(contract.endDate),
        valueCap: decimal(contract.valueCap),
        consumedValue: decimal("0.00"),
        source: "SIGNED_PDF",
        sourceFileName: contract.sourceFileName,
        signedDate: dateOnly(contract.signedDate),
      },
      update: {
        supplierId: contract.supplierId,
        supplierName: contract.supplierName,
        startDate: dateOnly(contract.startDate),
        endDate: dateOnly(contract.endDate),
        valueCap: decimal(contract.valueCap),
        source: "SIGNED_PDF",
        sourceFileName: contract.sourceFileName,
        signedDate: dateOnly(contract.signedDate),
      },
    });

    for (const line of contract.lines) {
      await tx.contractLine.upsert({
        where: {
          contractId_itemCode: {
            contractId: contract.id,
            itemCode: line.itemCode,
          },
        },
        create: {
          contractId: contract.id,
          itemCode: line.itemCode,
          description: line.description,
          uom: line.uom,
          rate: decimal(line.rate),
        },
        update: {
          description: line.description,
          uom: line.uom,
          rate: decimal(line.rate),
        },
      });

      importedLines += 1;
    }

    console.log(
      `${contract.id}: ${contract.supplierName} — ` +
        `${contract.lines.length} item lines processed`
    );
  }

  return importedLines;
}

async function main() {
  console.log("Cantill procurement — signed-contract import");
  console.log("Validating suppliers, items, and source PDFs...");

  const importedLines = await prisma.$transaction(
    async (tx) => {
      await validateReferences(tx);
      console.log("Reference validation passed.");

      return importSignedContracts(tx);
    },
    { maxWait: 10000, timeout: 30000 }
  );

  console.log("\nSigned-contract import completed successfully.");
  console.log(`Contracts processed: ${SIGNED_CONTRACTS.length}`);
  console.log(`Contract lines processed: ${importedLines}`);
  console.log("Existing registered contract consumption was not modified.");
}

main()
  .catch((error) => {
    console.error("\nSigned-contract import failed:");
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
