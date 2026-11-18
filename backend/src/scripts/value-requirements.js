
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const BATCH_ID = process.argv[2];
const POLICY_DOCUMENT = "CORVO-PROC-POL-04";

const REQUIRED_RULES = [
  "VALUE-3.1",
  "CONTRACT-4.1",
  "CONTRACT-4.2",
  "CONTRACT-4.3",
  "CONTRACT-4.4",
];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
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

function subtractDays(date, days) {
  const result = dateOnly(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

function money(value) {
  return new Prisma.Decimal(value).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP
  );
}

function compareContracts(a, b) {
  const rateComparison = a.rate.comparedTo(b.rate);

  if (rateComparison !== 0) {
    return rateComparison;
  }

  return a.contractId.localeCompare(b.contractId);
}

function validatePolicy(policy) {
  if (!policy) {
    throw new Error("Policy v5.0 is not registered.");
  }

  if (policy.status !== "ACTIVE") {
    throw new Error(`Policy v5.0 is not ACTIVE. Status: ${policy.status}`);
  }

  if (policy.documentCode !== POLICY_DOCUMENT) {
    throw new Error("Policy document code does not match the assessment.");
  }

  const rulesByCode = new Map(
    policy.rules.map((rule) => [rule.ruleCode, rule])
  );

  for (const ruleCode of REQUIRED_RULES) {
    const rule = rulesByCode.get(ruleCode);

    if (!rule || !rule.enabled) {
      throw new Error(
        `Required policy rule is missing or disabled: ${ruleCode}`
      );
    }
  }

  const valuationRule = rulesByCode.get("VALUE-3.1");

  const expectedPriority = [
    "USABLE_CONTRACT_RATE",
    "LOWEST_APPLICABLE_CONTRACT_RATE_IF_ALL_OUT_OF_CEILING",
    "MOST_RECENT_PO_PRICE_WITHIN_365_DAYS_BEFORE_REQUIREMENT_DATE",
    "ITEM_MASTER_STANDARD_PRICE",
  ];

  const actualPriority = valuationRule.conditions.unitPricePriority;

  if (
    JSON.stringify(actualPriority) !==
    JSON.stringify(expectedPriority)
  ) {
    throw new Error(
      "VALUE-3.1 price priority differs from the expected policy."
    );
  }

  return rulesByCode;
}

function buildContractIndex(contracts) {
  const index = new Map();

  for (const contract of contracts) {
    for (const line of contract.lines) {
      if (!index.has(line.itemCode)) {
        index.set(line.itemCode, []);
      }

      index.get(line.itemCode).push({
        contractId: contract.id,
        supplierName: contract.supplier.name,
        supplierStatus: contract.supplier.status,
        startDate: dateKey(contract.startDate),
        endDate: dateKey(contract.endDate),
        valueCap: new Prisma.Decimal(contract.valueCap),
        rate: new Prisma.Decimal(line.rate),
        uom: line.uom,
      });
    }
  }

  return index;
}

function buildHistoryIndex(history) {
  const index = new Map();

  for (const row of history) {
    if (!index.has(row.itemCode)) {
      index.set(row.itemCode, []);
    }

    index.get(row.itemCode).push({
      poNumber: row.poNumber,
      poDate: dateKey(row.poDate),
      unitPrice: new Prisma.Decimal(row.unitPrice),
      uom: row.uom,
    });
  }

  for (const rows of index.values()) {
    rows.sort((a, b) => {
      const dateComparison = b.poDate.localeCompare(a.poDate);

      if (dateComparison !== 0) {
        return dateComparison;
      }

      return a.poNumber.localeCompare(b.poNumber);
    });
  }

  return index;
}

function calculateValuation(
  requirement,
  contractIndex,
  historyIndex,
  remainingCeilings
) {
  const item = requirement.item;

  if (!item) {
    throw new Error(
      `Item master record missing for ${requirement.groupCode}.`
    );
  }

  const requirementDate = dateKey(
    dateOnly(requirement.firstCreatedAt)
  );

  const applicableContracts = (
    contractIndex.get(requirement.itemCode) || []
  ).filter((contract) => {
    return (
      contract.supplierStatus === "ACTIVE" &&
      requirementDate >= contract.startDate &&
      requirementDate <= contract.endDate
    );
  });

  for (const contract of applicableContracts) {
    if (contract.uom !== item.uom) {
      throw new Error(
        `UOM mismatch for ${requirement.groupCode}: ` +
          `${contract.contractId} has ${contract.uom}, ` +
          `but item master has ${item.uom}.`
      );
    }
  }

  const quantity = new Prisma.Decimal(requirement.totalQuantity);

  if (quantity.isNegative()) {
    throw new Error(
      `Invalid negative quantity for ${requirement.groupCode}: ${quantity}`
    );
  }

  if (applicableContracts.length > 0) {
    const candidates = applicableContracts.map((contract) => {
      const amount = money(quantity.mul(contract.rate));

      return {
        ...contract,
        amount,
        remaining: remainingCeilings.get(contract.contractId),
      };
    });

    const usableContracts = candidates
      .filter((contract) =>
        contract.remaining.greaterThanOrEqualTo(contract.amount)
      )
      .sort(compareContracts);

    if (usableContracts.length > 0) {
      const selected = usableContracts[0];

      remainingCeilings.set(
        selected.contractId,
        selected.remaining.minus(selected.amount)
      );

      return {
        requirementId: requirement.id,
        groupCode: requirement.groupCode,
        itemCode: requirement.itemCode,
        description: item.description,
        quantity,
        unitPrice: selected.rate,
        totalValue: selected.amount,
        source: "USABLE_CONTRACT",
        reference: selected.contractId,
        supplier: selected.supplierName,
        requirementDate,
        contractConsumed: selected.amount,
      };
    }

    const lowestRateContract = candidates.sort(compareContracts)[0];

    return {
      requirementId: requirement.id,
      groupCode: requirement.groupCode,
      itemCode: requirement.itemCode,
      description: item.description,
      quantity,
      unitPrice: lowestRateContract.rate,
      totalValue: lowestRateContract.amount,
      source: "CONTRACT_RATE_OUT_OF_CEILING",
      reference: lowestRateContract.contractId,
      supplier: lowestRateContract.supplierName,
      requirementDate,
      contractConsumed: new Prisma.Decimal(0),
    };
  }

  const cutoffDate = dateKey(
    subtractDays(requirement.firstCreatedAt, 365)
  );

  const recentHistory = (
    historyIndex.get(requirement.itemCode) || []
  ).filter(
    (row) =>
      row.poDate >= cutoffDate &&
      row.poDate < requirementDate
  );

  if (recentHistory.length > 0) {
    const latest = recentHistory[0];

    if (latest.uom !== item.uom) {
      throw new Error(
        `Purchase-history UOM mismatch for ${requirement.groupCode}: ` +
          `${latest.uom} versus item master ${item.uom}.`
      );
    }

    return {
      requirementId: requirement.id,
      groupCode: requirement.groupCode,
      itemCode: requirement.itemCode,
      description: item.description,
      quantity,
      unitPrice: latest.unitPrice,
      totalValue: money(quantity.mul(latest.unitPrice)),
      source: "PURCHASE_HISTORY",
      reference: latest.poNumber,
      supplier: null,
      requirementDate,
      contractConsumed: new Prisma.Decimal(0),
    };
  }

  const standardPrice = new Prisma.Decimal(item.standardPrice);

  if (standardPrice.lessThan(0)) {
    throw new Error(
      `Invalid standard price for ${requirement.itemCode}.`
    );
  }

  return {
    requirementId: requirement.id,
    groupCode: requirement.groupCode,
    itemCode: requirement.itemCode,
    description: item.description,
    quantity,
    unitPrice: standardPrice,
    totalValue: money(quantity.mul(standardPrice)),
    source: "ITEM_MASTER",
    reference: requirement.itemCode,
    supplier: null,
    requirementDate,
    contractConsumed: new Prisma.Decimal(0),
  };
}

async function main() {
  if (!BATCH_ID) {
    throw new Error("Usage: node src/scripts/value-requirements.js <batchId> [--apply]");
  }

  console.log("\n========================================");
  console.log("CORVO PROCUREMENT — REQUIREMENT VALUATION");
  console.log("========================================");

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  const policy = await prisma.policyVersion.findFirst({
    where: {
      documentCode: POLICY_DOCUMENT,
      status: "ACTIVE",
    },
    include: {
      rules: true,
    },
  });

  validatePolicy(policy);

  console.log(`Policy: ${POLICY_DOCUMENT} v${policy.version}`);

  const allRequirements = await prisma.requirement.findMany({
    where: {
      policyVersionId: policy.id,
      requestLines: {
        some: { batchId: BATCH_ID },
      },
    },
    include: {
      item: true,
    },
    orderBy: [
      { firstCreatedAt: "asc" },
      { groupCode: "asc" },
    ],
  });

  const newItemRequirements = allRequirements.filter(
    (requirement) => requirement.itemCode === null
  );

  for (const requirement of newItemRequirements) {
    if (
      requirement.valuationUnitPrice === null ||
      requirement.totalValue === null
    ) {
      throw new Error(
        `New-item requirement is unexpectedly unvalued: ${requirement.groupCode}`
      );
    }
  }

  const pendingRequirements = allRequirements.filter(
    (requirement) =>
      requirement.itemCode !== null &&
      requirement.valuationUnitPrice === null &&
      requirement.totalValue === null
  );

  const partiallyValued = allRequirements.filter(
    (requirement) =>
      requirement.itemCode !== null &&
      (
        (requirement.valuationUnitPrice === null) !==
        (requirement.totalValue === null)
      )
  );

  if (partiallyValued.length > 0) {
    throw new Error(
      "Some requirements have only one valuation field populated. " +
        "Inspect them before continuing."
    );
  }

  const alreadyValued = allRequirements.filter(
    (requirement) =>
      requirement.itemCode !== null &&
      requirement.valuationUnitPrice !== null &&
      requirement.totalValue !== null
  );

  console.log("\n========== REQUIREMENT COUNTS ==========");
  console.log("Total policy requirements:", allRequirements.length);
  console.log("New-item requirements preserved:", newItemRequirements.length);
  console.log("Already valued:", alreadyValued.length);
  console.log("Pending valuation:", pendingRequirements.length);

  if (pendingRequirements.length === 0) {
    console.log("\nNo pending requirements need valuation.");
    return;
  }

  const itemCodes = [
    ...new Set(pendingRequirements.map((r) => r.itemCode)),
  ];

  const [contracts, history] = await Promise.all([
    prisma.contract.findMany({
      include: {
        supplier: {
          select: {
            name: true,
            status: true,
          },
        },
        lines: {
          where: {
            itemCode: {
              in: itemCodes,
            },
          },
        },
      },
    }),

    prisma.purchaseHistory.findMany({
      where: {
        itemCode: {
          in: itemCodes,
        },
      },
      orderBy: [
        { poDate: "desc" },
        { poNumber: "asc" },
      ],
    }),
  ]);

  const contractIndex = buildContractIndex(contracts);
  const historyIndex = buildHistoryIndex(history);

  const remainingCeilings = new Map();

  for (const contract of contracts) {
    const cap = new Prisma.Decimal(contract.valueCap);
    const consumed = new Prisma.Decimal(contract.consumedValue);
    const remaining = cap.minus(consumed);

    if (remaining.lessThan(0)) {
      throw new Error(
        `Contract ${contract.id} has consumed value greater than its cap.`
      );
    }

    remainingCeilings.set(contract.id, remaining);
  }

  const results = [];

  for (const requirement of pendingRequirements) {
    const result = calculateValuation(
      requirement,
      contractIndex,
      historyIndex,
      remainingCeilings
    );

    results.push(result);
  }

  const sourceCounts = {};
  let grandTotal = new Prisma.Decimal(0);

  for (const result of results) {
    sourceCounts[result.source] =
      (sourceCounts[result.source] || 0) + 1;

    grandTotal = grandTotal.plus(result.totalValue);
  }

  console.log("\n========== VALUATION SOURCE SUMMARY ==========");

  for (const [source, count] of Object.entries(sourceCounts).sort()) {
    console.log(`${source}: ${count}`);
  }

  console.log("\n========== VALUATION DETAILS ==========");

  console.table(
    results.map((result) => ({
      groupCode: result.groupCode,
      itemCode: result.itemCode,
      quantity: result.quantity.toString(),
      unitPrice: result.unitPrice.toFixed(2),
      totalValue: result.totalValue.toFixed(2),
      source: result.source,
      reference: result.reference,
    }))
  );

  console.log("\n========== FINANCIAL SUMMARY ==========");
  console.log("Requirements valued:", results.length);
  console.log("Total requirement value (INR):", grandTotal.toFixed(2));

  console.log("\n========== PROJECTED CONTRACT USAGE ==========");

  const contractUsage = new Map();

  for (const result of results) {
    if (result.source !== "USABLE_CONTRACT") continue;

    const current = contractUsage.get(result.reference) || {
      supplier: result.supplier,
      allocated: new Prisma.Decimal(0),
    };

    current.allocated = current.allocated.plus(
      result.contractConsumed
    );

    contractUsage.set(result.reference, current);
  }

  if (contractUsage.size === 0) {
    console.log("No contract ceilings would be consumed.");
  } else {
    for (const [contractId, usage] of contractUsage) {
      console.log({
        contractId,
        supplier: usage.supplier,
        projectedAllocation: usage.allocated.toFixed(2),
        projectedRemaining:
          remainingCeilings.get(contractId).toFixed(2),
      });
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN COMPLETE.");
    console.log("No database records were changed.");
    console.log(
      "Review the valuation details before running with --apply."
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const result of results) {
      const updated = await tx.requirement.updateMany({
        where: {
          id: result.requirementId,
          valuationUnitPrice: null,
          totalValue: null,
        },
        data: {
          valuationUnitPrice: result.unitPrice,
          totalValue: result.totalValue,
        },
      });

      if (updated.count !== 1) {
        throw new Error(
          `Could not safely update ${result.groupCode}. ` +
            "The requirement may have changed since the dry run."
        );
      }
    }
  });

  console.log("\n========== APPLY RESULT ==========");
  console.log("Requirements valued:", results.length);
  console.log("Total requirement value (INR):", grandTotal.toFixed(2));
  console.log("Transaction committed successfully.");
  console.log("Contract consumedValue fields were not modified.");
}

main()
  .catch((error) => {
    console.error("\nRequirement valuation failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
