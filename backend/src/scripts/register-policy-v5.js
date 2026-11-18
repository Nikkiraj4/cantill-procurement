import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLICY_FILE = path.resolve(
  __dirname,
  "../../../data/source/policies/Corvo_Procurement_Policy.pdf"
);

const POLICY = {
  version: "5.0",
  documentCode: "CORVO-PROC-POL-04",
  effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
  sourceFileName: "Corvo_Procurement_Policy.pdf",
  changeSummary:
    "Initial baseline registration of Corvo Engineering Procurement Policy v5.0.",
};

const RULES = [
  {
    ruleCode: "ITEM-1.1",
    section: "1.1",
    priority: 10,
    name: "Identify item from PR line",
    description:
      "Use the requester's item code when supplied; otherwise match the description to the item master.",
    conditions: {
      itemCodeProvided: true,
      matchingMethod: "EXACT_ITEM_CODE",
      fallbackWhenNoItemCode: "DESCRIPTION_TO_ITEM_MASTER",
    },
    outcome: {
      resolvedItem: "ITEM_MASTER_RECORD",
    },
  },
  {
    ruleCode: "ITEM-1.2",
    section: "1.2",
    priority: 20,
    name: "Unmatched line is a new item",
    description:
      "A line matching no item master item is always sent to new-item sourcing, is never clubbed, and is valued using the requester's estimated unit price.",
    conditions: {
      noItemMasterMatch: true,
    },
    outcome: {
      resolvedItemCode: "NEW",
      route: "NEW_ITEM_SOURCING",
      decision: "SOURCING_REQUEST",
      clubbingAllowed: false,
      valuation: "QUANTITY_MULTIPLIED_BY_ESTIMATED_UNIT_PRICE",
      supplierSuggestions: 0,
    },
  },
  {
    ruleCode: "CLUB-2.1",
    section: "2.1",
    priority: 30,
    name: "Prevent requirement splitting",
    description:
      "Similar PR lines must be treated as one requirement so policy limits apply to their total value.",
    conditions: {
      evaluateSimilarPurchaseLinesTogether: true,
    },
    outcome: {
      applyLimitsTo: "TOTAL_REQUIREMENT_VALUE",
      splittingToAvoidLimitsAllowed: false,
    },
  },
  {
    ruleCode: "CLUB-2.2",
    section: "2.2",
    priority: 40,
    name: "Requirement clubbing windows",
    description:
      "Process PR lines by creation time, then PR number, then line number. A line can join a requirement only when item and plant match, it is within 14 calendar days of the first line, and its need-by date is within seven days either side of the first line's need-by date. Choose the earliest qualifying requirement.",
    conditions: {
      sortBy: ["createdAt", "prNumber", "lineNumber"],
      sameItem: true,
      samePlant: true,
      createdWithinCalendarDaysOfFirstLine: 14,
      needByDateWithinDaysOfFirstLine: 7,
      needByDateWindowIsSymmetric: true,
      anchor: "FIRST_LINE",
    },
    outcome: {
      join: "EARLIEST_QUALIFYING_REQUIREMENT",
      otherwise: "CREATE_NEW_REQUIREMENT",
    },
  },
  {
    ruleCode: "CLUB-2.3",
    section: "2.3",
    priority: 50,
    name: "Requirement date and emergency inheritance",
    description:
      "The requirement date is the creation date of its first line. Contract validity and purchase history are checked as of this date. Any Emergency line makes the whole requirement an emergency.",
    conditions: {
      requirementDate: "FIRST_LINE_CREATION_DATE",
      contractAndHistoryAsOfRequirementDate: true,
      emergencyIfAnyLineIsEmergency: true,
    },
    outcome: {
      requirementDate: "FIRST_LINE_CREATION_DATE",
      isEmergency: "ANY_LINE_EMERGENCY",
    },
  },
  {
    ruleCode: "VALUE-3.1",
    section: "3.1",
    priority: 60,
    name: "Requirement valuation hierarchy",
    description:
      "Requirement value is total quantity multiplied by the selected unit price. Select the contract rate that will be used; if all applicable contracts are out of ceiling, use the lowest applicable contract rate. Otherwise use the most recent PO price within 365 days before the requirement date, then the item master standard price.",
    conditions: {
      quantity: "SUM_OF_REQUIREMENT_LINE_QUANTITIES",
      unitPricePriority: [
        "USABLE_CONTRACT_RATE",
        "LOWEST_APPLICABLE_CONTRACT_RATE_IF_ALL_OUT_OF_CEILING",
        "MOST_RECENT_PO_PRICE_WITHIN_365_DAYS_BEFORE_REQUIREMENT_DATE",
        "ITEM_MASTER_STANDARD_PRICE",
      ],
      historyWindowCalendarDays: 365,
    },
    outcome: {
      requirementValue: "TOTAL_QUANTITY_MULTIPLIED_BY_UNIT_PRICE",
      currency: "INR",
      excludesGST: true,
    },
  },
  {
    ruleCode: "CONTRACT-4.1",
    section: "4.1",
    priority: 70,
    name: "Contract applicability",
    description:
      "A contract applies when it covers the item, the requirement date is within its start and end dates inclusive, and its supplier is Active.",
    conditions: {
      contractCoversItem: true,
      requirementDateWithinContractDates: {
        inclusive: true,
      },
      supplierStatus: "ACTIVE",
    },
    outcome: {
      contractIsApplicable: true,
    },
  },
  {
    ruleCode: "CONTRACT-4.2",
    section: "4.2",
    priority: 80,
    name: "Contract ceiling and consumption order",
    description:
      "A contract can be used only when consumed value plus this requirement's value at the contract rate does not exceed its ceiling. Requirements consume ceiling in requirement-date order. Contracts signed after the register's last update start with zero consumption.",
    conditions: {
      ceilingCheck:
        "CONSUMED_VALUE_PLUS_REQUIREMENT_VALUE_AT_CONTRACT_RATE_LESS_THAN_OR_EQUAL_TO_CEILING",
      consumptionOrder: "REQUIREMENT_DATE",
      contractsSignedAfterRegisterUpdateStartWithConsumedValue: 0,
    },
    outcome: {
      useContractOnlyWhenCeilingAvailable: true,
    },
  },
  {
    ruleCode: "CONTRACT-4.3",
    section: "4.3",
    priority: 90,
    name: "Select lowest usable contract rate",
    description:
      "When multiple contracts apply, use the contract with the lowest rate that still has enough ceiling.",
    conditions: {
      multipleApplicableContracts: true,
    },
    outcome: {
      selection: "LOWEST_RATE_WITH_SUFFICIENT_CEILING",
    },
  },
  {
    ruleCode: "DECISION-5.1",
    section: "5.1",
    priority: 100,
    name: "Capex sourcing",
    description:
      "Capex items go to sourcing with five supplier suggestions and require capex approval.",
    conditions: {
      itemType: "CAPEX",
    },
    outcome: {
      decision: "SOURCING_REQUEST",
      route: "CAPEX_SOURCING",
      suggestedSupplierCount: 5,
      requiresCapexApproval: true,
    },
  },
  {
    ruleCode: "DECISION-5.2",
    section: "5.2",
    priority: 110,
    name: "Usable contract purchase order",
    description:
      "If a contract can be used under sections 4.1 to 4.3, place a contract PO at the contract supplier's rate.",
    conditions: {
      usableContractExists: true,
    },
    outcome: {
      decision: "PO",
      route: "CONTRACT_PO",
      supplier: "CONTRACT_SUPPLIER",
      unitPrice: "CONTRACT_RATE",
    },
  },
  {
    ruleCode: "DECISION-5.3",
    section: "5.3",
    priority: 120,
    name: "Emergency purchase order",
    description:
      "An emergency requirement valued at or below INR 500,000 can use a direct PO when the item was bought from an Active supplier in the last 365 days. Use the first preferred supplier at its reference price.",
    conditions: {
      isEmergency: true,
      requirementValueINR: {
        lessThanOrEqualTo: 500000,
      },
      itemBoughtFromActiveSupplierWithinDays: 365,
    },
    outcome: {
      decision: "PO",
      route: "EMERGENCY_PO",
      supplier: "FIRST_PREFERRED_SUPPLIER",
      unitPrice: "PREFERRED_SUPPLIER_REFERENCE_PRICE",
    },
  },
  {
    ruleCode: "DECISION-5.4",
    section: "5.4",
    priority: 130,
    name: "Spot purchase order",
    description:
      "A requirement below INR 200,000 can use a direct PO when the item was bought from an Active supplier in the last 365 days. Use the first preferred supplier at its reference price.",
    conditions: {
      requirementValueINR: {
        lessThan: 200000,
      },
      itemBoughtFromActiveSupplierWithinDays: 365,
    },
    outcome: {
      decision: "PO",
      route: "SPOT_PO",
      supplier: "FIRST_PREFERRED_SUPPLIER",
      unitPrice: "PREFERRED_SUPPLIER_REFERENCE_PRICE",
    },
  },
  {
    ruleCode: "DECISION-5.5",
    section: "5.5",
    priority: 140,
    name: "RFQ sourcing",
    description:
      "Requirements below INR 1,000,000 that have not matched an earlier decision rule go to RFQ, including small items never bought in the last 365 days.",
    conditions: {
      requirementValueINR: {
        lessThan: 1000000,
      },
    },
    outcome: {
      decision: "SOURCING_REQUEST",
      route: "RFQ",
      suggestedSupplierCount: 3,
    },
  },
  {
    ruleCode: "DECISION-5.6",
    section: "5.6",
    priority: 150,
    name: "RFP sourcing",
    description:
      "Requirements valued at INR 1,000,000 or more go to RFP.",
    conditions: {
      requirementValueINR: {
        greaterThanOrEqualTo: 1000000,
      },
    },
    outcome: {
      decision: "SOURCING_REQUEST",
      route: "RFP",
      suggestedSupplierCount: 5,
    },
  },
  {
    ruleCode: "SUPPLIER-5.7",
    section: "5.7",
    priority: 160,
    name: "Exclude blocked and inactive suppliers",
    description:
      "Blocked or Inactive suppliers must never receive a PO or be suggested for a sourcing event.",
    conditions: {
      supplierStatusIneligible: ["BLOCKED", "INACTIVE"],
    },
    outcome: {
      mayReceivePO: false,
      mayBeSuggested: false,
    },
  },
  {
    ruleCode: "PREFERRED-6.1",
    section: "6.1",
    priority: 170,
    name: "Preferred supplier eligibility",
    description:
      "Include every Active supplier with at least one PO for the item in the preceding 548 days, or a contract covering the item that started on or before the requirement date, even if the contract has since expired.",
    conditions: {
      supplierStatus: "ACTIVE",
      eligibleWhenAny: [
        {
          purchaseOrderForItemWithinDaysBeforeRequirementDate: 548,
        },
        {
          contractCoversItem: true,
          contractStartOnOrBeforeRequirementDate: true,
          contractMayBeExpired: true,
        },
      ],
    },
    outcome: {
      includeInPreferredSupplierList: true,
    },
  },
  {
    ruleCode: "PREFERRED-6.2",
    section: "6.2",
    priority: 180,
    name: "Preferred supplier ranking factors",
    description:
      "Rank eligible suppliers using purchase frequency, purchase recency, contract holding, on-time delivery, and quality. The weighting must be consistent, explainable, and recorded.",
    conditions: {
      rankingFactors: [
        "PURCHASE_FREQUENCY",
        "PURCHASE_RECENCY",
        "CONTRACT_HOLDING",
        "ON_TIME_DELIVERY",
        "QUALITY",
      ],
    },
    outcome: {
      rankingMustBe: [
        "CONSISTENT",
        "EXPLAINABLE_TO_BUYER",
        "RECORDED",
      ],
    },
  },
  {
    ruleCode: "PREFERRED-6.3",
    section: "6.3",
    priority: 190,
    name: "Preferred supplier reference price",
    description:
      "Use the supplier's most recent PO price for the item within 548 days. If there is no such PO, use the rate in the supplier's most recent contract for the item.",
    conditions: {
      referencePricePriority: [
        "MOST_RECENT_PO_PRICE_WITHIN_548_DAYS",
        "MOST_RECENT_CONTRACT_RATE_FOR_ITEM",
      ],
    },
    outcome: {
      referencePrice: "FIRST_AVAILABLE_PRICE_IN_PRIORITY_ORDER",
    },
  },
  {
    ruleCode: "PREFERRED-6.4",
    section: "6.4",
    priority: 200,
    name: "Supplier suggestions for sourcing",
    description:
      "Take suppliers from the preferred list in rank order. If fewer than three or five are available, add other Active suppliers listing the item's category, ordered by best delivery and quality. New items receive no suggestions.",
    conditions: {
      preferredListFirst: true,
      topUpFromActiveSuppliersListingItemCategory: true,
      topUpRanking: ["DELIVERY", "QUALITY"],
      newItem: true,
    },
    outcome: {
      newItemSuggestedSupplierCount: 0,
      otherwise: "FILL_REQUIRED_COUNT_FROM_PREFERRED_THEN_OTHER_ACTIVE_CATEGORY_SUPPLIERS",
    },
  },
  {
    ruleCode: "PO-7.1",
    section: "7.1",
    priority: 210,
    name: "PO consolidation eligibility",
    description:
      "PO requirements may be combined when they have the same supplier, plant, and route, and are raised within 24 hours of the first requirement on that PO. Time is measured from the creation time of each requirement's first line.",
    conditions: {
      sameSupplier: true,
      samePlant: true,
      sameRoute: true,
      withinHoursOfFirstRequirement: 24,
      timestampSource: "CREATION_TIME_OF_REQUIREMENT_FIRST_LINE",
    },
    outcome: {
      combineAs: "ONE_PO_WITH_MULTIPLE_LINES",
    },
  },
  {
    ruleCode: "PO-7.2",
    section: "7.2",
    priority: 220,
    name: "PO consolidation order",
    description:
      "Process requirements in creation-time order. Join the earliest open PO that qualifies; otherwise create a new PO. Sourcing requests are never combined.",
    conditions: {
      requirementSort: "CREATION_TIME",
      eligibleOpenPOSelection: "EARLIEST_QUALIFYING_OPEN_PO",
      sourcingRequestsCanBeCombined: false,
    },
    outcome: {
      qualifyingOpenPO: "ADD_REQUIREMENT_AS_PO_LINE",
      noQualifyingOpenPO: "CREATE_NEW_PO",
      sourcingRequest: "DO_NOT_CONSOLIDATE",
    },
  },
  {
    ruleCode: "AUDIT-8.1",
    section: "8.1",
    priority: 230,
    name: "Decision audit and buyer override",
    description:
      "Every decision records the policy clause applied and the contract or PO relied on. A buyer override requires a written reason retained with the original decision.",
    conditions: {
      decisionMustRecord: [
        "POLICY_CLAUSE",
        "CONTRACT_OR_PO_RELIED_ON",
      ],
      overrideRequiresWrittenReason: true,
    },
    outcome: {
      preserveOriginalDecision: true,
      retainOverrideReason: true,
    },
  },
];

async function main() {
  if (!existsSync(POLICY_FILE)) {
    throw new Error(`Policy PDF not found: ${POLICY_FILE}`);
  }

  console.log("Cantill procurement — register policy v5.0");
  console.log(`Source PDF: ${POLICY_FILE}`);
  console.log(`Policy: ${POLICY.documentCode}, version ${POLICY.version}`);
  console.log(`Effective from: ${POLICY.effectiveFrom.toISOString()}`);
  console.log(`Rules to register: ${RULES.length}`);

  const existing = await prisma.policyVersion.findUnique({
    where: {
      version: POLICY.version,
    },
    include: {
      rules: {
        select: {
          ruleCode: true,
        },
      },
    },
  });

  if (existing) {
    const expectedRuleCodes = RULES.map((rule) => rule.ruleCode).sort();
    const existingRuleCodes = existing.rules
      .map((rule) => rule.ruleCode)
      .sort();

    const sameRules =
      expectedRuleCodes.length === existingRuleCodes.length &&
      expectedRuleCodes.every(
        (ruleCode, index) => ruleCode === existingRuleCodes[index]
      );

    const sameMetadata =
      existing.documentCode === POLICY.documentCode &&
      existing.effectiveFrom.getTime() === POLICY.effectiveFrom.getTime() &&
      existing.sourceFileName === POLICY.sourceFileName;

    if (!sameMetadata || !sameRules) {
      throw new Error(
        "Policy v5.0 already exists but its metadata or rules differ. " +
          "No changes were made; inspect the existing policy before proceeding."
      );
    }

    console.log("");
    console.log("Policy v5.0 is already registered correctly.");
    console.log(`Existing status: ${existing.status}`);
    console.log(`Existing rules: ${existing.rules.length}`);
    console.log("No database changes were made.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    const policyVersion = await tx.policyVersion.create({
      data: {
        version: POLICY.version,
        documentCode: POLICY.documentCode,
        effectiveFrom: POLICY.effectiveFrom,
        status: "ACTIVE",
        sourceFileName: POLICY.sourceFileName,
        changeSummary: POLICY.changeSummary,
        activatedAt: new Date(),
        approvedBy: null,
        approvedAt: null,
        createdBy: null,
      },
    });

    await tx.policyRule.createMany({
      data: RULES.map((rule) => ({
        policyVersionId: policyVersion.id,
        ruleCode: rule.ruleCode,
        section: rule.section,
        priority: rule.priority,
        name: rule.name,
        description: rule.description,
        conditions: rule.conditions,
        outcome: rule.outcome,
        enabled: true,
      })),
    });

    console.log("");
    console.log("Policy v5.0 and its rules were committed.");
    console.log(`Policy ID: ${policyVersion.id}`);
  });

  console.log(`Registered rules: ${RULES.length}`);
  console.log("Policy status: ACTIVE");
  console.log("Approval identity and timestamp: not supplied by source.");
}

main()
  .catch((error) => {
    console.error("");
    console.error("Policy registration failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
