import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const BATCH_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");

const POLICY_CODE = "CORVO-PROC-POL-04";
const LOOKBACK_548_DAYS = 548;
const LOOKBACK_365_DAYS = 365;

const WEIGHTS = {
  purchaseFrequency: 0.30,
  purchaseRecency: 0.25,
  contractHolding: 0.20,
  onTimeDelivery: 0.15,
  quality: 0.10,
};

const REQUIRED_RULES = [
  "CONTRACT-4.1",
  "CONTRACT-4.2",
  "CONTRACT-4.3",
  "DECISION-5.1",
  "DECISION-5.2",
  "DECISION-5.3",
  "DECISION-5.4",
  "DECISION-5.5",
  "DECISION-5.6",
  "SUPPLIER-5.7",
  "PREFERRED-6.1",
  "PREFERRED-6.2",
  "PREFERRED-6.3",
  "PREFERRED-6.4",
];

const money = (value) => new Prisma.Decimal(value ?? 0);

const dateOnly = (date) =>
  new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

const daysBefore = (date, days) =>
  new Date(date.getTime() - days * 24 * 60 * 60 * 1000);

const daysBetween = (earlier, later) =>
  Math.max(
    0,
    Math.floor((later.getTime() - earlier.getTime()) / 86400000)
  );

const round = (value, digits = 4) =>
  Number(value.toFixed(digits));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getActiveRuleMap(rules) {
  const map = new Map(
    rules
      .filter((rule) => rule.enabled)
      .map((rule) => [rule.ruleCode, rule])
  );

  for (const code of REQUIRED_RULES) {
    assert(map.has(code), `Required active policy rule missing: ${code}`);
  }

  return map;
}

function getReferencePrice(supplierId, itemCode, asOfDate, history, contracts) {
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
      date: recentPOs[0].poDate.toISOString(),
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
    .sort((a, b) => b.contract.startDate - a.contract.startDate);

  if (contractRates.length > 0) {
    const selected = contractRates[0];

    return {
      price: money(selected.rate),
      source: "CONTRACT_RATE",
      reference: selected.contract.id,
      date: selected.contract.startDate.toISOString(),
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
            100 * (1 - daysSinceLastPurchase / LOOKBACK_548_DAYS)
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
      daysSinceLastPurchase,
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
      Math.min(100, Number(entry.supplier.onTimePct ?? 0))
    );

    const qualityScore = Math.max(
      0,
      Math.min(100, Number(entry.supplier.qualityRating ?? 0) * 20)
    );

    const score =
      frequencyScore * WEIGHTS.purchaseFrequency +
      entry.recencyScore * WEIGHTS.purchaseRecency +
      contractScore * WEIGHTS.contractHolding +
      onTimeScore * WEIGHTS.onTimeDelivery +
      qualityScore * WEIGHTS.quality;

    return {
      ...entry,
      score: round(score),
      explanation: {
        scoringModel: "CORVO-PREFERRED-SUPPLIER-v1",
        weights: WEIGHTS,
        factors: {
          purchaseFrequency: {
            count: entry.frequency,
            normalizedScore: round(frequencyScore),
          },
          purchaseRecency: {
            daysSinceLastPurchase: entry.daysSinceLastPurchase,
            normalizedScore: round(entry.recencyScore),
          },
          contractHolding: {
            hasEligibleContract: entry.hasContract,
            normalizedScore: contractScore,
          },
          onTimeDelivery: {
            supplierValue: Number(entry.supplier.onTimePct ?? 0),
            normalizedScore: round(onTimeScore),
          },
          quality: {
            supplierRating: Number(entry.supplier.qualityRating ?? 0),
            normalizedScore: round(qualityScore),
          },
        },
        totalScore: round(score),
        referencePrice: {
          value: entry.referencePrice.price?.toString() ?? null,
          source: entry.referencePrice.source,
          reference: entry.referencePrice.reference,
          date: entry.referencePrice.date,
        },
      },
    };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.supplier.id.localeCompare(b.supplier.id)
  );

  return ranked;
}

function getSupplierSuggestions({
  requiredCount,
  preferred,
  item,
  suppliers,
}) {
  const selected = [];
  const selectedIds = new Set();

  for (const entry of preferred) {
    if (selected.length >= requiredCount) break;

    selected.push({
      supplierId: entry.supplier.id,
      reason: `Preferred supplier rank ${selected.length + 1}; score ${entry.score}.`,
    });

    selectedIds.add(entry.supplier.id);
  }

  const fallbackSuppliers = suppliers
    .filter(
      (supplier) =>
        supplier.status === "ACTIVE" &&
        !selectedIds.has(supplier.id) &&
        supplier.categories.some(
          (category) => category.category === item.category
        )
    )
    .sort(
      (a, b) =>
        Number(b.onTimePct ?? 0) - Number(a.onTimePct ?? 0) ||
        Number(b.qualityRating ?? 0) -
          Number(a.qualityRating ?? 0) ||
        a.id.localeCompare(b.id)
    );

  for (const supplier of fallbackSuppliers) {
    if (selected.length >= requiredCount) break;

    selected.push({
      supplierId: supplier.id,
      reason:
        "Active supplier added from item category; ranked by delivery and quality.",
    });

    selectedIds.add(supplier.id);
  }

  return selected;
}

function getUsableContract({
  requirement,
  itemCode,
  contracts,
  remainingCeilings,
}) {
  if (!itemCode) return null;

  const applicable = contracts
    .filter((contract) => {
      if (contract.supplier.status !== "ACTIVE") return false;
      if (contract.startDate > requirement.firstCreatedAt) return false;
      if (contract.endDate < requirement.firstCreatedAt) return false;

      return contract.lines.some(
        (line) => line.itemCode === itemCode
      );
    })
    .map((contract) => {
      const line = contract.lines.find(
        (entry) => entry.itemCode === itemCode
      );

      const rate = money(line.rate);
      const requiredContractValue = money(
        requirement.totalQuantity
      ).times(rate);

      const remaining = remainingCeilings.get(contract.id);

      return {
        contract,
        line,
        rate,
        requiredContractValue,
        remaining,
      };
    });

  const usable = applicable
    .filter((entry) =>
      entry.requiredContractValue.lte(entry.remaining)
    )
    .sort(
      (a, b) =>
        a.rate.comparedTo(b.rate) ||
        a.contract.id.localeCompare(b.contract.id)
    );

  return usable[0] ?? null;
}

function determineDecision({
  requirement,
  item,
  preferred,
  suppliers,
  history,
  contracts,
  remainingCeilings,
  rules,
}) {
  const value = money(requirement.totalValue);
  const asOfDate = requirement.firstCreatedAt;

  if (Number(requirement.totalQuantity) <= 0) {
    return {
      decisionType: "NOT_PROCESSED",
      route: "NOT_PROCESSED",
      appliedClause: "INPUT-VALIDATION",
      supplierId: null,
      unitPrice: null,
      suggestions: [],
      contract: null,
      reason:
        "Quantity must be greater than zero. This requirement is held for buyer review; no procurement action is created.",
      evidence: {
        validation: "ZERO_OR_NEGATIVE_QUANTITY",
        totalQuantity: requirement.totalQuantity.toString(),
        requirementValue: value.toString(),
      },
    };
  }

  const emergencyRule = rules.get("DECISION-5.3");
  const spotRule = rules.get("DECISION-5.4");
  const rfqRule = rules.get("DECISION-5.5");
  const rfpRule = rules.get("DECISION-5.6");
  const capexRule = rules.get("DECISION-5.1");

  const emergencyLimit = Number(
    emergencyRule.conditions.requirementValueINR.lessThanOrEqualTo
  );
  const emergencyLookbackDays = Number(
    emergencyRule.conditions.itemBoughtFromActiveSupplierWithinDays
  );
  const spotLimit = Number(
    spotRule.conditions.requirementValueINR.lessThan
  );
  const spotLookbackDays = Number(
    spotRule.conditions.itemBoughtFromActiveSupplierWithinDays
  );
  const rfqLimit = Number(
    rfqRule.conditions.requirementValueINR.lessThan
  );
  const rfpLimit = Number(
    rfpRule.conditions.requirementValueINR.greaterThanOrEqualTo
  );

  const capexSupplierCount = Number(
    capexRule.outcome.suggestedSupplierCount
  );
  const rfqSupplierCount = Number(
    rfqRule.outcome.suggestedSupplierCount
  );
  const rfpSupplierCount = Number(
    rfpRule.outcome.suggestedSupplierCount
  );

  assert(
    [emergencyLimit, spotLimit, rfqLimit, rfpLimit,
      emergencyLookbackDays, spotLookbackDays,
      capexSupplierCount, rfqSupplierCount, rfpSupplierCount]
      .every(Number.isFinite),
    "Active policy contains invalid decision thresholds or supplier counts."
  );

  assert(
    emergencyLimit > 0 &&
    spotLimit > 0 &&
    rfqLimit > spotLimit &&
    rfpLimit === rfqLimit &&
    emergencyLookbackDays > 0 &&
    spotLookbackDays > 0 &&
    capexSupplierCount >= 1 &&
    rfqSupplierCount >= 1 &&
    rfpSupplierCount >= 1,
    "Active policy decision rules are inconsistent or invalid."
  );

  const hasRecentActivePurchase = (lookbackDays) =>
    history.some(
      (row) =>
        row.itemCode === item.code &&
        row.poDate >= daysBefore(asOfDate, lookbackDays) &&
        row.poDate <= asOfDate &&
        row.supplier.status === "ACTIVE"
    );

  if (!item) {
    return {
      decisionType: "SOURCING_REQUEST",
      route: "NEW_ITEM_SOURCING",
      appliedClause: "1.2",
      supplierId: null,
      unitPrice: requirement.valuationUnitPrice,
      suggestions: [],
      contract: null,
      reason:
        "Unmatched item-master entry. New items require separate sourcing and receive no supplier suggestions.",
      evidence: {
        itemCode: null,
        newItem: true,
        valuationMethod: "REQUESTER_ESTIMATE",
        requirementValue: value.toString(),
      },
    };
  }

  if (item.itemType === "CAPEX") {
    const suggestions = getSupplierSuggestions({
      requiredCount: capexSupplierCount,
      preferred,
      item,
      suppliers,
    });

    return {
      decisionType: "SOURCING_REQUEST",
      route: "CAPEX_SOURCING",
      appliedClause: "5.1",
      supplierId: null,
      unitPrice: null,
      suggestions,
      contract: null,
      reason:
        `Capex items require sourcing with ${capexSupplierCount} supplier suggestions and capex approval.`,
      evidence: {
        itemType: item.itemType,
        requiresCapexApproval: true,
        requiredSuggestionCount: capexSupplierCount,
        actualSuggestionCount: suggestions.length,
      },
    };
  }

  const usableContract = getUsableContract({
    requirement,
    itemCode: item.code,
    contracts,
    remainingCeilings,
  });

  if (usableContract) {
    remainingCeilings.set(
      usableContract.contract.id,
      usableContract.remaining.minus(
        usableContract.requiredContractValue
      )
    );

    return {
      decisionType: "PO",
      route: "CONTRACT_PO",
      appliedClause: "5.2",
      supplierId: usableContract.contract.supplierId,
      unitPrice: usableContract.rate,
      suggestions: [],
      contract: usableContract,
      reason:
        "An applicable Active contract has sufficient remaining ceiling. The lowest usable contract rate was selected.",
      evidence: {
        contractId: usableContract.contract.id,
        contractSource: usableContract.contract.source,
        contractSupplierId: usableContract.contract.supplierId,
        contractRate: usableContract.rate.toString(),
        requirementValueAtContractRate:
          usableContract.requiredContractValue.toString(),
        remainingCeilingBefore:
          usableContract.remaining.toString(),
        remainingCeilingAfter: remainingCeilings
          .get(usableContract.contract.id)
          .toString(),
      },
    };
  }

  const emergencyRecentActivePurchase =
    hasRecentActivePurchase(emergencyLookbackDays);
  const spotRecentActivePurchase =
    hasRecentActivePurchase(spotLookbackDays);

  if (
    requirement.isEmergency &&
    value.lte(emergencyLimit) &&
    emergencyRecentActivePurchase
  ) {
    const firstPreferred = preferred.find(
      (entry) => entry.referencePrice.price !== null
    );

    assert(
      firstPreferred,
      `Emergency requirement ${requirement.groupCode} qualifies for direct PO but has no preferred supplier with a reference price.`
    );

    return {
      decisionType: "PO",
      route: "EMERGENCY_PO",
      appliedClause: "5.3",
      supplierId: firstPreferred.supplier.id,
      unitPrice: firstPreferred.referencePrice.price,
      suggestions: [],
      contract: null,
      reason:
        `Emergency requirement is within INR ${emergencyLimit.toLocaleString("en-IN")} and the item was purchased from an Active supplier within ${emergencyLookbackDays} days. First preferred supplier selected at its reference price.`,
      evidence: {
        emergency: true,
        requirementValue: value.toString(),
        emergencyLimitINR: emergencyLimit,
        recentActivePurchaseWithinDays: emergencyLookbackDays,
        selectedSupplierId: firstPreferred.supplier.id,
        referencePrice: firstPreferred.referencePrice.price.toString(),
        referencePriceSource: firstPreferred.referencePrice.source,
        referencePriceReference: firstPreferred.referencePrice.reference,
      },
    };
  }

  if (value.lt(spotLimit) && spotRecentActivePurchase) {
    const firstPreferred = preferred.find(
      (entry) => entry.referencePrice.price !== null
    );

    assert(
      firstPreferred,
      `Spot requirement ${requirement.groupCode} qualifies for direct PO but has no preferred supplier with a reference price.`
    );

    return {
      decisionType: "PO",
      route: "SPOT_PO",
      appliedClause: "5.4",
      supplierId: firstPreferred.supplier.id,
      unitPrice: firstPreferred.referencePrice.price,
      suggestions: [],
      contract: null,
      reason:
        `Requirement is below INR ${spotLimit.toLocaleString("en-IN")} and the item was purchased from an Active supplier within ${spotLookbackDays} days. First preferred supplier selected at its reference price.`,
      evidence: {
        requirementValue: value.toString(),
        spotLimitINR: spotLimit,
        recentActivePurchaseWithinDays: spotLookbackDays,
        selectedSupplierId: firstPreferred.supplier.id,
        referencePrice: firstPreferred.referencePrice.price.toString(),
        referencePriceSource: firstPreferred.referencePrice.source,
        referencePriceReference: firstPreferred.referencePrice.reference,
      },
    };
  }

  if (value.lt(rfqLimit)) {
    const suggestions = getSupplierSuggestions({
      requiredCount: rfqSupplierCount,
      preferred,
      item,
      suppliers,
    });

    return {
      decisionType: "SOURCING_REQUEST",
      route: "RFQ",
      appliedClause: "5.5",
      supplierId: null,
      unitPrice: null,
      suggestions,
      contract: null,
      reason:
        `Requirement value is below INR ${rfqLimit.toLocaleString("en-IN")} and no earlier decision rule applies. RFQ sourcing is required.`,
      evidence: {
        requirementValue: value.toString(),
        rfqLimitINR: rfqLimit,
        requiredSuggestionCount: rfqSupplierCount,
        actualSuggestionCount: suggestions.length,
      },
    };
  }

  assert(
    value.gte(rfpLimit),
    `Requirement ${requirement.groupCode} does not match an active policy decision threshold.`
  );

  const suggestions = getSupplierSuggestions({
    requiredCount: rfpSupplierCount,
    preferred,
    item,
    suppliers,
  });

  return {
    decisionType: "SOURCING_REQUEST",
    route: "RFP",
    appliedClause: "5.6",
    supplierId: null,
    unitPrice: null,
    suggestions,
    contract: null,
    reason:
      `Requirement value is INR ${rfpLimit.toLocaleString("en-IN")} or more. RFP sourcing is required.`,
    evidence: {
      requirementValue: value.toString(),
      rfpLimitINR: rfpLimit,
      requiredSuggestionCount: rfpSupplierCount,
      actualSuggestionCount: suggestions.length,
    },
  };
}

async function main() {
  if (!BATCH_ID) {
    throw new Error("Usage: node src/scripts/process-procurement-decisions.js <batchId> [--apply]");
  }

  console.log("\n========================================");
  console.log("CORVO PROCUREMENT — DECISION ENGINE");
  console.log("========================================");
  console.log("Mode:", APPLY ? "APPLY" : "DRY RUN");
  const policy = await prisma.policyVersion.findFirst({
    where: {
      documentCode: POLICY_CODE,
      status: "ACTIVE",
    },
    include: {
      rules: {
        orderBy: { priority: "asc" },
      },
    },
  });

  assert(policy, "No active procurement policy was found.");

  console.log("Policy:", `${POLICY_CODE} v${policy.version}`);

  const rules = getActiveRuleMap(policy.rules);

  const [
    requirements,
    suppliers,
    contracts,
    history,
    existingDecisionCount,
    existingSnapshotCount,
    existingSourcingCount,
  ] = await Promise.all([
    prisma.requirement.findMany({
      where: {
        requestLines: { some: { batchId: BATCH_ID } },
      },
      include: { item: true },
      orderBy: [
        { firstCreatedAt: "asc" },
        { groupCode: "asc" },
      ],
    }),
    prisma.supplier.findMany({
      include: { categories: true },
      orderBy: { id: "asc" },
    }),
    prisma.contract.findMany({
      include: {
        supplier: true,
        lines: true,
      },
    }),
    prisma.purchaseHistory.findMany({
      include: { supplier: true },
      orderBy: { poDate: "desc" },
    }),
    prisma.procurementDecision.count({
      where: {
        requirement: { requestLines: { some: { batchId: BATCH_ID } } },
      },
    }),
    prisma.preferredSupplierSnapshot.count({
      where: { policyVersionId: policy.id },
    }),
    prisma.sourcingRequest.count({
      where: {
        requirement: { requestLines: { some: { batchId: BATCH_ID } } },
      },
    }),
  ]);

  console.log("\n========== INPUT COUNTS ==========");
  console.log("Requirements:", requirements.length);
  console.log(
    "Active suppliers:",
    suppliers.filter((supplier) => supplier.status === "ACTIVE").length
  );
  console.log("Contracts:", contracts.length);
  console.log("Purchase history:", history.length);
  console.log("Existing decisions:", existingDecisionCount);
  console.log("Existing preferred snapshots:", existingSnapshotCount);
  console.log("Existing sourcing requests:", existingSourcingCount);

  assert(requirements.length > 0, "No requirements found.");
  assert(
    existingDecisionCount === 0,
    "Existing decisions found. Refusing to process requirements again."
  );
  assert(
    requirements.every((requirement) => requirement.status === "PENDING"),
    "Some requirements are not PENDING. Refusing to process mixed statuses."
  );

  for (const requirement of requirements) {
    assert(
      requirement.totalValue !== null,
      `Requirement ${requirement.groupCode} has no valuation.`
    );

    assert(
      requirement.policyVersionId === policy.id,
      `Requirement ${requirement.groupCode} is not linked to active policy v${policy.version}.`
    );
  }

  const remainingCeilings = new Map(
    contracts.map((contract) => [
      contract.id,
      money(contract.valueCap).minus(
        contract.source === "SIGNED_PDF"
          ? 0
          : contract.consumedValue
      ),
    ])
  );

  const snapshots = new Map();
  const plans = [];

  for (const requirement of requirements) {
    const item = requirement.item;
    const asOfDate = dateOnly(requirement.firstCreatedAt);

    let preferred = [];

    if (item) {
      const snapshotKey = `${item.code}|${asOfDate.toISOString()}`;

      if (!snapshots.has(snapshotKey)) {
        preferred = buildPreferredSuppliers({
          item,
          asOfDate,
          suppliers,
          history,
          contracts,
        });

        snapshots.set(snapshotKey, {
          itemCode: item.code,
          asOfDate,
          entries: preferred,
        });
      } else {
        preferred = snapshots.get(snapshotKey).entries;
      }
    }

    const decision = determineDecision({
      requirement,
      item,
      preferred,
      suppliers,
      history,
      contracts,
      remainingCeilings,
      rules,
    });

    if (decision.supplierId) {
      const supplier = suppliers.find(
        (entry) => entry.id === decision.supplierId
      );

      assert(
        supplier?.status === "ACTIVE",
        `Decision selected an ineligible supplier for ${requirement.groupCode}.`
      );
    }

    for (const suggestion of decision.suggestions) {
      const supplier = suppliers.find(
        (entry) => entry.id === suggestion.supplierId
      );

      assert(
        supplier?.status === "ACTIVE",
        `Decision suggested an ineligible supplier for ${requirement.groupCode}.`
      );
    }

    plans.push({
      requirement,
      decision,
      preferred,
    });
  }

  const routeCounts = {};
  const clauseCounts = {};
  let suggestionCount = 0;
  let directPOCount = 0;
  let sourcingCount = 0;
  let notProcessedCount = 0;
  let totalValue = money(0);

  for (const plan of plans) {
    const { requirement, decision } = plan;

    routeCounts[decision.route] =
      (routeCounts[decision.route] || 0) + 1;

    clauseCounts[decision.appliedClause] =
      (clauseCounts[decision.appliedClause] || 0) + 1;

    suggestionCount += decision.suggestions.length;
    totalValue = totalValue.plus(requirement.totalValue);

    if (decision.decisionType === "PO") directPOCount++;
    if (decision.decisionType === "SOURCING_REQUEST") sourcingCount++;
    if (decision.decisionType === "NOT_PROCESSED") notProcessedCount++;
  }

  console.log("\n========== DECISION ROUTE COUNTS ==========");
  for (const [route, count] of Object.entries(routeCounts)) {
    console.log(`${route}: ${count}`);
  }

  console.log("\n========== APPLIED POLICY CLAUSES ==========");
  for (const [clause, count] of Object.entries(clauseCounts)) {
    console.log(`${clause}: ${count}`);
  }

  console.log("\n========== PROCESSING SUMMARY ==========");
  console.log("Requirements processed:", plans.length);
  console.log("Direct PO decisions:", directPOCount);
  console.log("Sourcing decisions:", sourcingCount);
  console.log("Not processed:", notProcessedCount);
  console.log("Supplier suggestions:", suggestionCount);
  console.log("Preferred supplier snapshots:", snapshots.size);
  console.log("Total requirement value:", `INR ${totalValue.toFixed(2)}`);

  console.log("\n========== DECISION PREVIEW ==========");

  for (const plan of plans) {
    console.log({
      requirement: plan.requirement.groupCode,
      itemCode: plan.requirement.itemCode,
      value: plan.requirement.totalValue.toString(),
      emergency: plan.requirement.isEmergency,
      route: plan.decision.route,
      clause: plan.decision.appliedClause,
      supplierId: plan.decision.supplierId,
      unitPrice: plan.decision.unitPrice?.toString() ?? null,
      suggestions: plan.decision.suggestions.map(
        (entry) => entry.supplierId
      ),
    });
  }

  assert(
    plans.length === requirements.length,
    "Not all requirements were processed."
  );

  assert(
    directPOCount + sourcingCount + notProcessedCount === requirements.length,
    "Decision type counts do not match requirement count."
  );

  console.log("\n========== VALIDATION ==========");
  console.log("All requirements valued: YES");
  console.log(`All requirements linked to policy v${policy.version}: YES`);
  console.log("Blocked/inactive suppliers selected: NO");
  console.log("Duplicate requirement decisions: NO");
  console.log("Contract ceiling simulation: COMPLETED");
  console.log("Decision validation: PASSED");

  if (!APPLY) {
    console.log("\nDRY RUN ONLY — no database records were changed.");
    console.log(
      `After reviewing the output, use: node src/scripts/process-procurement-decisions.js ${BATCH_ID} --apply`
    );
    return;
  }

  assert(
    existingSnapshotCount === 0 && existingSourcingCount === 0,
    "Existing preferred snapshots or sourcing requests found. Refusing to apply."
  );

  await prisma.$transaction(
    async (tx) => {
      const currentDecisionCount =
        await tx.procurementDecision.count({
          where: {
            requirement: {
              requestLines: { some: { batchId: BATCH_ID } },
            },
          },
        });

      assert(
        currentDecisionCount === 0,
        "A decision was created during validation. Transaction cancelled."
      );

            for (const snapshot of snapshots.values()) {
        await tx.preferredSupplierSnapshot.create({
          data: {
            item: {
              connect: { code: snapshot.itemCode },
            },
            asOfDate: snapshot.asOfDate,
            policyVersion: {
              connect: { id: policy.id },
            },
            entries: {
              create: snapshot.entries.map((entry, index) => ({
                supplier: {
                  connect: { id: entry.supplier.id },
                },
                item: {
                  connect: { code: snapshot.itemCode },
                },
                rank: index + 1,
                score: money(entry.score),
                referencePrice: entry.referencePrice.price,
                explanation: entry.explanation,
              })),
            },
          },
        });
      }

      for (const plan of plans) {
        const { requirement, decision } = plan;

        const createdDecision =
          await tx.procurementDecision.create({
            data: {
              requirementId: requirement.id,
              policyVersionId: policy.id,
              decisionType: decision.decisionType,
              route: decision.route,
              supplierId: decision.supplierId,
              unitPrice: decision.unitPrice,
              groupValue: requirement.totalValue,
              appliedClause: decision.appliedClause,
              reason: decision.reason,
              evidence: {
                ...decision.evidence,
                policyCode: POLICY_CODE,
                policyVersion: policy.version,
                requirementDate:
                  requirement.firstCreatedAt.toISOString(),
                requirementGroupCode: requirement.groupCode,
                preferredSupplierScoringWeights: WEIGHTS,
                preferredSupplierRanking: plan.preferred.map(
                  (entry, index) => ({
                    rank: index + 1,
                    supplierId: entry.supplier.id,
                    score: entry.score,
                  })
                ),
                contractAllocation:
                  decision.contract
                    ? {
                        contractId: decision.contract.contract.id,
                        amount: decision.contract.requiredContractValue.toString(),
                      }
                    : null,
              },
                          suggestions: {
                create: decision.suggestions.map(
                  (suggestion, index) => ({
                    supplier: {
                      connect: { id: suggestion.supplierId },
                    },
                    rank: index + 1,
                    reason: suggestion.reason,
                  })
                ),
              },
            },
          });

        if (decision.decisionType === "SOURCING_REQUEST") {
          await tx.sourcingRequest.create({
            data: {
              requirementId: requirement.id,
              status: "OPEN",
            },
          });
        }

        await tx.requirement.update({
          where: { id: requirement.id },
          data: {
            status:
              decision.decisionType === "NOT_PROCESSED"
                ? "NOT_PROCESSED"
                : "DECIDED",
          },
        });

        assert(
          createdDecision.requirementId === requirement.id,
          `Decision persistence verification failed for ${requirement.groupCode}.`
        );
      }
    },
    {
      maxWait: 10000,
      timeout: 120000,
    }
  );

  console.log("\n========== COMMIT RESULT ==========");
  console.log("Decisions created:", plans.length);
  console.log("Preferred snapshots created:", snapshots.size);
  console.log("Supplier suggestions created:", suggestionCount);
  console.log("Sourcing requests created:", sourcingCount);
  console.log(
    "Requirements marked DECIDED:",
    directPOCount + sourcingCount
  );
  console.log("Requirements marked NOT_PROCESSED:", notProcessedCount);
  console.log("Transaction committed successfully.");
}

main()
  .catch((error) => {
    console.error("\nProcurement decision processing failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
