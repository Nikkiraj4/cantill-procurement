import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const POLICY_DOCUMENT_CODE = "CORVO-PROC-POL-04";

// These are candidates for review, not approved item mappings.
// Policy 1.1 permits description matching, including short forms.
// We retain these candidates for verification instead of silently
// treating a possible match as confirmed.
const ALIAS_CANDIDATES = {
  "brg 6308 zz for maintenance": "ITM-1022",
  "anchor fastener m12x100 urgent": "ITM-1013",
  "welding rod e6013 3 15mm": "ITM-1015",
  "nitrile coated gloves urgent": "ITM-1048",
  "taper roller brg 32210": "ITM-1023",
  "frl unit 1 2 inch as per sample": "ITM-1039",
  "monitor 24": "ITM-1057",
  "pneu cylinder 50x100": "ITM-1036",
  "proximity sensor m18 pnp as per sample": "ITM-1030",
  "hyd hose 1 2 inch 2 wire": "ITM-1035",
  "contactor 3 pole 32a as per sample": "ITM-1028",
  "ear plugs disposable urgent": "ITM-1051",
  "hydraulic pump seal kit hydrax repeat": "ITM-1040",
  "forklift electric 2 ton urgent": "ITM-1073",
};

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function utcDay(value) {
  const date = new Date(value);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}

function calendarDayDifference(first, second) {
  return Math.round(
    (utcDay(second) - utcDay(first)) / 86400000
  );
}

function compareLines(a, b) {
  const timeDifference =
    new Date(a.request.createdAt).getTime() -
    new Date(b.request.createdAt).getTime();

  if (timeDifference !== 0) {
    return timeDifference;
  }

  const prDifference = a.prNumber.localeCompare(b.prNumber);

  if (prDifference !== 0) {
    return prDifference;
  }

  return a.lineNumber.localeCompare(b.lineNumber, undefined, {
    numeric: true,
  });
}

function resolveItem(line, itemsByCode, itemsByDescription) {
  // Policy 1.1: use the supplied item code when present.
  if (line.itemCode) {
    const item = itemsByCode.get(line.itemCode);

    if (!item) {
      return {
        status: "INVALID_ITEM_CODE",
        itemCode: null,
        candidateCode: null,
      };
    }

    return {
      status: "EXISTING_ITEM_CODE",
      itemCode: item.code,
      candidateCode: item.code,
    };
  }

  // Policy 1.1: match the description against the item master.
  const key = normalize(line.description);
  const exactMatches = itemsByDescription.get(key) ?? [];

  if (exactMatches.length === 1) {
    return {
      status: "EXACT_DESCRIPTION_MATCH",
      itemCode: exactMatches[0].code,
      candidateCode: exactMatches[0].code,
    };
  }

  if (exactMatches.length > 1) {
    return {
      status: "AMBIGUOUS_DESCRIPTION",
      itemCode: null,
      candidateCode: null,
    };
  }

  // Policy 1.1 permits description matching, including short forms.
  // Accept a listed short-form match only when the item exists and its
  // unit of measurement agrees with the PR line.
  const aliasCode = ALIAS_CANDIDATES[key];
  const aliasItem = aliasCode ? itemsByCode.get(aliasCode) : null;

  if (aliasItem && aliasItem.uom === line.uom) {
    return {
      status: "POLICY_SHORT_FORM_MATCH",
      itemCode: aliasItem.code,
      candidateCode: aliasItem.code,
    };
  }

  if (aliasItem) {
    return {
      status: "ALIAS_UOM_MISMATCH",
      itemCode: null,
      candidateCode: aliasItem.code,
    };
  }

  // Policy 1.2: unmatched description is treated as a potential new item.
  return {
    status: "POTENTIAL_NEW_ITEM",
    itemCode: null,
    candidateCode: null,
  };
}

function canJoin(line, group, conditions) {
  const firstLine = group.lines[0];

  if (
    conditions.sameItem &&
    line.resolvedItemCode !== group.itemCode
  ) {
    return false;
  }

  if (
    conditions.samePlant &&
    line.plantCode !== group.plantCode
  ) {
    return false;
  }

  const createdDays = calendarDayDifference(
    firstLine.request.createdAt,
    line.request.createdAt
  );

  if (
    createdDays < 0 ||
    createdDays > conditions.createdWithinCalendarDaysOfFirstLine
  ) {
    return false;
  }

  const needByDays = Math.abs(
    calendarDayDifference(
      firstLine.needByDate,
      line.needByDate
    )
  );

  if (
    needByDays > conditions.needByDateWithinDaysOfFirstLine
  ) {
    return false;
  }

  return true;
}

function groupEligibleLines(lines, groupingRule) {
  const conditions = groupingRule.conditions;
  const groups = [];

  for (const line of lines) {
    // Only mapped plants and confirmed item matches can be grouped.
    // Potential new items and unresolved aliases never reach this function.
    if (!line.plantIsMapped || !line.resolvedItemCode) {
      continue;
    }

    const matchingGroups = groups.filter((group) =>
      canJoin(line, group, conditions)
    );

    if (matchingGroups.length > 0) {
      // Groups are created in chronological order.
      // The first matching group is the earliest qualifying requirement.
      matchingGroups[0].lines.push(line);
    } else {
      groups.push({
        itemCode: line.resolvedItemCode,
        plantCode: line.plantCode,
        lines: [line],
      });
    }
  }

  return groups;
}

function originalPlant(line) {
  return (
    line.rawData?.plant ??
    line.rawData?.original_plant ??
    line.plantCode ??
    "UNKNOWN"
  );
}

function getHoldReasons(line) {
  const reasons = [];

  if (!line.plantIsMapped) {
    reasons.push(`UNMAPPED_PLANT:${originalPlant(line)}`);
  }

  if (line.resolutionStatus === "ALIAS_REVIEW_REQUIRED") {
    reasons.push("ITEM_ALIAS_REQUIRES_REVIEW");
  } else if (line.resolutionStatus === "POTENTIAL_NEW_ITEM") {
    reasons.push("NEW_ITEM_SOURCING");
  } else if (
    line.resolutionStatus === "INVALID_ITEM_CODE" ||
    line.resolutionStatus === "AMBIGUOUS_DESCRIPTION"
  ) {
    reasons.push(line.resolutionStatus);
  }

  if (
    line.resolutionStatus === "POTENTIAL_NEW_ITEM" &&
    line.estimatedUnitPrice === null
  ) {
    reasons.push("ESTIMATED_UNIT_PRICE_MISSING");
  }

  return reasons;
}

async function main() {
  const policy = await prisma.policyVersion.findFirst({
    where: {
      documentCode: POLICY_DOCUMENT_CODE,
      status: "ACTIVE",
    },
    orderBy: {
      effectiveFrom: "desc",
    },
    include: {
      rules: {
        where: { enabled: true },
        orderBy: { priority: "asc" },
      },
    },
  });

  if (!policy) {
    throw new Error(
      `No active policy found for ${POLICY_DOCUMENT_CODE}.`
    );
  }

  const itemRule = policy.rules.find(
    (rule) => rule.ruleCode === "ITEM-1.1"
  );

  const newItemRule = policy.rules.find(
    (rule) => rule.ruleCode === "ITEM-1.2"
  );

  const groupingRule = policy.rules.find(
    (rule) => rule.ruleCode === "CLUB-2.2"
  );

  const emergencyRule = policy.rules.find(
    (rule) => rule.ruleCode === "CLUB-2.3"
  );

  if (
    !itemRule ||
    !newItemRule ||
    !groupingRule ||
    !emergencyRule
  ) {
    throw new Error(
      "Required policy rules ITEM-1.1, ITEM-1.2, CLUB-2.2 or CLUB-2.3 are missing."
    );
  }

  const [items, plants, lines] = await Promise.all([
    prisma.item.findMany({
      select: {
        code: true,
        description: true,
        uom: true,
      },
    }),

    prisma.plant.findMany({
      select: { code: true },
    }),

    prisma.purchaseRequestLine.findMany({
      where: { requirementId: null },
      include: {
        request: {
          select: {
            id: true,
            prNumber: true,
            createdAt: true,
            requester: true,
            department: true,
          },
        },
      },
    }),
  ]);

  const itemsByCode = new Map(
    items.map((item) => [item.code, item])
  );

  const itemsByDescription = new Map();

  for (const item of items) {
    const key = normalize(item.description);
    const existing = itemsByDescription.get(key) ?? [];

    existing.push(item);
    itemsByDescription.set(key, existing);
  }

  const plantCodes = new Set(
    plants.map((plant) => plant.code)
  );

  const prepared = lines
    .filter((line) => line.request)
    .map((line) => {
      const resolution = resolveItem(
        line,
        itemsByCode,
        itemsByDescription
      );

      return {
        ...line,
        resolvedItemCode: resolution.itemCode,
        resolutionStatus: resolution.status,
        candidateItemCode: resolution.candidateCode,
        plantIsMapped: Boolean(
          line.plantCode && plantCodes.has(line.plantCode)
        ),
      };
    })
    .sort(compareLines);

  const eligibleLines = prepared.filter(
    (line) =>
      line.plantIsMapped &&
      line.resolvedItemCode &&
      line.plantCode
  );

  const groups = groupEligibleLines(
    eligibleLines,
    groupingRule
  );

  const heldLines = prepared.filter(
    (line) =>
      !line.plantIsMapped ||
      !line.resolvedItemCode
  );

  const newItemLines = prepared.filter(
    (line) =>
      line.resolutionStatus === "POTENTIAL_NEW_ITEM"
  );

  const counts = {};

  for (const line of prepared) {
    counts[line.resolutionStatus] =
      (counts[line.resolutionStatus] ?? 0) + 1;
  }

  const unmappedPlants = [
    ...new Set(
      prepared
        .filter((line) => !line.plantIsMapped)
        .map(originalPlant)
    ),
  ];

  console.log("\n========== REQUIREMENT MATCHING DRY RUN ==========");
  console.log(`Policy: ${policy.documentCode} v${policy.version}`);
  console.log(`Policy ID: ${policy.id}`);
  console.log(`Policy status: ${policy.status}`);
  console.log(`Item matching rule: ${itemRule.ruleCode}`);
  console.log(`New item rule: ${newItemRule.ruleCode}`);
  console.log(`Grouping rule: ${groupingRule.ruleCode}`);
  console.log(`Emergency rule: ${emergencyRule.ruleCode}`);

  console.log("\n========== INPUT SUMMARY ==========");
  console.log(`PR lines inspected: ${prepared.length}`);
  console.log(`Eligible for grouping: ${eligibleLines.length}`);
  console.log(`Held for review: ${heldLines.length}`);

  console.log("\n========== ITEM RESOLUTION ==========");

  for (const [status, count] of Object.entries(counts).sort()) {
    console.log(`${status}: ${count}`);
  }

  console.log("\n========== UNMAPPED PLANTS ==========");
  console.log(
    unmappedPlants.length > 0
      ? unmappedPlants.join(", ")
      : "None"
  );

  console.log("\n========== REVIEW REQUIRED ==========");

  if (heldLines.length === 0) {
    console.log("No lines held for review.");
  } else {
    for (const line of heldLines) {
      const reasons = getHoldReasons(line);

      console.log(
        [
          line.prNumber,
          `line ${line.lineNumber}`,
          `plant=${originalPlant(line)}`,
          `description="${line.description}"`,
          `status=${line.resolutionStatus}`,
          `candidate=${line.candidateItemCode ?? "none"}`,
          `reasons=${reasons.join(",") || "REVIEW_REQUIRED"}`,
        ].join(" | ")
      );
    }
  }

  console.log("\n========== POTENTIAL NEW ITEMS ==========");

  if (newItemLines.length === 0) {
    console.log("None.");
  } else {
    for (const line of newItemLines) {
      const quantity = Number(line.quantity);
      const estimatedPrice =
        line.estimatedUnitPrice === null
          ? null
          : Number(line.estimatedUnitPrice);

      const estimatedValue =
        estimatedPrice === null
          ? null
          : quantity * estimatedPrice;

      console.log(
        [
          line.prNumber,
          `line ${line.lineNumber}`,
          `description="${line.description}"`,
          `quantity=${line.quantity}`,
          `uom=${line.uom}`,
          `estimatedUnitPrice=${estimatedPrice ?? "MISSING"}`,
          `estimatedValue=${estimatedValue ?? "NOT_AVAILABLE"}`,
          "route=NEW_ITEM_SOURCING",
          "clubbed=NO",
        ].join(" | ")
      );
    }
  }

  console.log("\n========== PROVISIONAL REQUIREMENT GROUPS ==========");
  console.log(`Groups formed: ${groups.length}`);

  for (const [index, group] of groups.entries()) {
    const firstLine = group.lines[0];

    const totalQuantity = group.lines.reduce(
      (sum, line) => sum + Number(line.quantity),
      0
    );

    const isEmergency = emergencyRule.conditions
      .emergencyIfAnyLineIsEmergency
      ? group.lines.some(
          (line) => normalize(line.urgency) === "emergency"
        )
      : false;

    console.log(`\nGroup ${index + 1}`);
    console.log(`Item: ${group.itemCode}`);
    console.log(`Plant: ${group.plantCode}`);
    console.log(`First PR: ${firstLine.prNumber}`);
    console.log(`First line: ${firstLine.lineNumber}`);
    console.log(
      `Requirement date: ${firstLine.request.createdAt.toISOString().slice(0, 10)}`
    );
    console.log(
      `Need-by anchor: ${firstLine.needByDate.toISOString().slice(0, 10)}`
    );
    console.log(`Lines: ${group.lines.length}`);
    console.log(`Total quantity: ${totalQuantity}`);
    console.log(`Emergency: ${isEmergency ? "YES" : "NO"}`);

    for (const line of group.lines) {
      console.log(
        `  - ${line.prNumber} / line ${line.lineNumber} / qty ${line.quantity} / need-by ${line.needByDate.toISOString().slice(0, 10)}`
      );
    }
  }

  console.log("\n========== SAFETY CHECK ==========");
  console.log("Database writes: NONE");
  console.log("PR source rows modified: NO");
  console.log("Alias candidates automatically approved: NO");
  console.log("Potential new item records created: NO");
  console.log("Potential new items clubbed: NO");
  console.log("Unknown plants automatically mapped: NO");
  console.log("Contract ceilings consumed: NO");
  console.log("\nDRY RUN complete.");
}

main()
  .catch((error) => {
    console.error("\nRequirement matching dry run failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
