import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BATCH_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");

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
  return Math.round((utcDay(second) - utcDay(first)) / 86400000);
}

function compareLines(a, b) {
  const timeDifference =
    new Date(a.request.createdAt).getTime() -
    new Date(b.request.createdAt).getTime();

  if (timeDifference !== 0) return timeDifference;

  const prDifference = a.prNumber.localeCompare(b.prNumber);
  if (prDifference !== 0) return prDifference;

  return a.lineNumber.localeCompare(b.lineNumber, undefined, {
    numeric: true,
  });
}

function resolveItem(line, itemsByCode, itemsByDescription) {
  if (line.itemCode) {
    const item = itemsByCode.get(line.itemCode);

    return item
      ? { status: "EXISTING_ITEM_CODE", itemCode: item.code }
      : { status: "INVALID_ITEM_CODE", itemCode: null };
  }

  const key = normalize(line.description);
  const exactMatches = itemsByDescription.get(key) ?? [];

  if (exactMatches.length === 1) {
    return {
      status: "EXACT_DESCRIPTION_MATCH",
      itemCode: exactMatches[0].code,
    };
  }

  if (exactMatches.length > 1) {
    return { status: "AMBIGUOUS_DESCRIPTION", itemCode: null };
  }

  const aliasCode = ALIAS_CANDIDATES[key];
  const aliasItem = aliasCode ? itemsByCode.get(aliasCode) : null;

  if (aliasItem && aliasItem.uom === line.uom) {
    return {
      status: "POLICY_SHORT_FORM_MATCH",
      itemCode: aliasItem.code,
    };
  }

  if (aliasItem) {
    return { status: "ALIAS_UOM_MISMATCH", itemCode: null };
  }

  return { status: "POTENTIAL_NEW_ITEM", itemCode: null };
}

function canJoin(line, group, conditions) {
  const firstLine = group.lines[0];

  if (conditions.sameItem && line.resolvedItemCode !== group.itemCode) {
    return false;
  }

  if (conditions.samePlant && line.plantCode !== group.plantCode) {
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
    calendarDayDifference(firstLine.needByDate, line.needByDate)
  );

  return needByDays <= conditions.needByDateWithinDaysOfFirstLine;
}

function groupEligibleLines(lines, conditions) {
  const groups = [];

  for (const line of lines) {
    if (!line.plantIsMapped || !line.resolvedItemCode || !line.plantCode) {
      continue;
    }

    const matchingGroups = groups.filter((group) =>
      canJoin(line, group, conditions)
    );

    if (matchingGroups.length > 0) {
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

function makeGroupCode(firstLine) {
  return `REQ-${firstLine.batchId.slice(-6)}-${firstLine.prNumber}-${firstLine.lineNumber}`;
}

function makeNewItemGroupCode(line) {
  return `REQ-NEW-${line.batchId.slice(-6)}-${line.prNumber}-${line.lineNumber}`;
}

function decimalSum(lines) {
  return lines.reduce(
    (sum, line) => sum.plus(line.quantity),
    new Prisma.Decimal(0)
  );
}

function isEmergencyGroup(lines, emergencyRule) {
  if (!emergencyRule.conditions.emergencyIfAnyLineIsEmergency) {
    return false;
  }

  return lines.some(
    (line) => normalize(line.urgency) === "emergency"
  );
}

async function buildPlan() {
  if (!BATCH_ID) {
    throw new Error("Usage: node src/scripts/create-requirements.js <batchId> [--apply]");
  }

  const policy = await prisma.policyVersion.findFirst({
    where: { documentCode: "CORVO-PROC-POL-04", status: "ACTIVE" },
    include: {
      rules: {
        where: { enabled: true },
        orderBy: { priority: "asc" },
      },
    },
  });

  if (!policy) {
    throw new Error("No active CORVO-PROC-POL-04 policy was found.");
  }

  const groupingRule = policy.rules.find(
    (rule) => rule.ruleCode === "CLUB-2.2"
  );

  const emergencyRule = policy.rules.find(
    (rule) => rule.ruleCode === "CLUB-2.3"
  );

  const itemRule = policy.rules.find(
    (rule) => rule.ruleCode === "ITEM-1.1"
  );

  const newItemRule = policy.rules.find(
    (rule) => rule.ruleCode === "ITEM-1.2"
  );

  if (!groupingRule || !emergencyRule || !itemRule || !newItemRule) {
    throw new Error("One or more required policy v5.0 rules are missing.");
  }

  const [items, plants, lines] = await Promise.all([
    prisma.item.findMany({
      select: { code: true, description: true, uom: true },
    }),

    prisma.plant.findMany({
      select: { code: true },
    }),

    prisma.purchaseRequestLine.findMany({
      where: { batchId: BATCH_ID, requirementId: null },
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

  const itemsByCode = new Map(items.map((item) => [item.code, item]));
  const itemsByDescription = new Map();

  for (const item of items) {
    const key = normalize(item.description);
    const matches = itemsByDescription.get(key) ?? [];

    matches.push(item);
    itemsByDescription.set(key, matches);
  }

  const plantCodes = new Set(plants.map((plant) => plant.code));

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
    groupingRule.conditions
  );

  const heldLines = prepared.filter(
    (line) => !line.plantIsMapped || !line.resolvedItemCode
  );

  const newItemLines = prepared.filter(
    (line) => line.resolutionStatus === "POTENTIAL_NEW_ITEM"
  );

  return {
    policy,
    itemsByCode,
    prepared,
    eligibleLines,
    groups,
    heldLines,
    newItemLines,
    emergencyRule,
  };
}

function validatePlan(plan) {
  const errors = [];
  const seenLineIds = new Set();

  const itemUoms = new Map(
    [...plan.itemsByCode.values()].map((item) => [item.code, item.uom])
  );

  for (const [index, group] of plan.groups.entries()) {
    const firstLine = group.lines[0];
    const groupCode = makeGroupCode(firstLine);

    if (!groupCode || !group.itemCode || !group.plantCode) {
      errors.push(`Group ${index + 1} has missing identity fields.`);
    }

    if (!itemUoms.has(group.itemCode)) {
      errors.push(
        `${groupCode}: item ${group.itemCode} is not in the item master.`
      );
    }

    for (const line of group.lines) {
      if (seenLineIds.has(line.id)) {
        errors.push(`${groupCode}: a PR line appears in multiple groups.`);
      }

      seenLineIds.add(line.id);

      if (line.requirementId !== null) {
        errors.push(`${groupCode}: a PR line is already linked.`);
      }

      if (line.uom !== itemUoms.get(group.itemCode)) {
        errors.push(
          `${groupCode}: UOM mismatch for ${line.prNumber}/${line.lineNumber}.`
        );
      }

      if (line.plantCode !== group.plantCode || !line.plantIsMapped) {
        errors.push(`${groupCode}: invalid or unmapped plant.`);
      }
    }
  }

  const newItemCodes = [];

  for (const line of plan.newItemLines) {
    const groupCode = makeNewItemGroupCode(line);
    newItemCodes.push(groupCode);

    if (!groupCode) {
      errors.push("A new-item requirement has a missing group code.");
    }

    if (!line.description?.trim()) {
      errors.push(`${groupCode}: missing item description.`);
    }

    if (!line.uom?.trim()) {
      errors.push(`${groupCode}: missing unit of measure.`);
    }

    if (!line.plantIsMapped || !line.plantCode) {
      errors.push(`${groupCode}: new item has an unmapped plant.`);
    }

    if (!line.request?.createdAt || !line.needByDate) {
      errors.push(`${groupCode}: missing PR creation or need-by date.`);
    }

    if (line.quantity === null || line.quantity === undefined) {
      errors.push(`${groupCode}: missing quantity.`);
    } else {
      try {
        new Prisma.Decimal(line.quantity);
      } catch {
        errors.push(`${groupCode}: invalid quantity.`);
      }
    }

    if (
      line.estimatedUnitPrice === null ||
      line.estimatedUnitPrice === undefined
    ) {
      errors.push(`${groupCode}: missing requester estimated unit price.`);
    } else {
      try {
        new Prisma.Decimal(line.estimatedUnitPrice);
      } catch {
        errors.push(`${groupCode}: invalid requester estimated unit price.`);
      }
    }

    if (line.requirementId !== null) {
      errors.push(`${groupCode}: new-item PR line is already linked.`);
    }

    if (seenLineIds.has(line.id)) {
      errors.push(`${groupCode}: PR line appears more than once.`);
    }

    seenLineIds.add(line.id);
  }

  const groupCodes = [
    ...plan.groups.map((group) => makeGroupCode(group.lines[0])),
    ...newItemCodes,
  ];

  if (new Set(groupCodes).size !== groupCodes.length) {
    errors.push("Generated requirement codes are not unique.");
  }

  const groupedLineCount = plan.groups.reduce(
    (sum, group) => sum + group.lines.length,
    0
  );

  if (groupedLineCount !== plan.eligibleLines.length) {
    errors.push(
      `Grouped line count ${groupedLineCount} does not equal eligible line count ${plan.eligibleLines.length}.`
    );
  }

  return errors;
}

async function applyPlan(plan) {
  return prisma.$transaction(
    async (tx) => {
      let createdRequirements = 0;
      let linkedLines = 0;

      for (const group of plan.groups) {
        const firstLine = group.lines[0];
        const groupCode = makeGroupCode(firstLine);
        const totalQuantity = decimalSum(group.lines);

        const isEmergency = isEmergencyGroup(
          group.lines,
          plan.emergencyRule
        );

        const existing = await tx.requirement.findUnique({
          where: { groupCode },
        });

        let requirement;

        if (existing) {
          const sameRequirement =
            existing.itemCode === group.itemCode &&
            existing.plantCode === group.plantCode &&
            existing.firstCreatedAt.getTime() ===
              firstLine.request.createdAt.getTime() &&
            existing.firstNeedByDate.getTime() ===
              firstLine.needByDate.getTime() &&
            new Prisma.Decimal(existing.totalQuantity).equals(totalQuantity) &&
            existing.isEmergency === isEmergency &&
            existing.policyVersionId === plan.policy.id;

          if (!sameRequirement) {
            throw new Error(
              `Existing requirement ${groupCode} conflicts with the calculated group.`
            );
          }

          requirement = existing;
        } else {
          requirement = await tx.requirement.create({
            data: {
              groupCode,
              itemCode: group.itemCode,
              plantCode: group.plantCode,
              firstCreatedAt: firstLine.request.createdAt,
              firstNeedByDate: firstLine.needByDate,
              totalQuantity,
              valuationUnitPrice: null,
              totalValue: null,
              isEmergency,
              status: "PENDING",
              policyVersionId: plan.policy.id,
            },
          });

          createdRequirements += 1;
        }

        const lineIds = group.lines.map((line) => line.id);

        const linkedLinesForGroup =
          await tx.purchaseRequestLine.findMany({
            where: {
              id: { in: lineIds },
              requirementId: { not: null },
            },
            select: {
              id: true,
              requirementId: true,
            },
          });

        const conflictingLink = linkedLinesForGroup.find(
          (line) => line.requirementId !== requirement.id
        );

        if (conflictingLink) {
          throw new Error(
            `A PR line in ${groupCode} is already linked to another requirement.`
          );
        }

        const updateResult = await tx.purchaseRequestLine.updateMany({
          where: {
            id: { in: lineIds },
            requirementId: null,
          },
          data: {
            requirementId: requirement.id,
          },
        });

        linkedLines += updateResult.count;

        const verifiedCount = await tx.purchaseRequestLine.count({
          where: {
            id: { in: lineIds },
            requirementId: requirement.id,
          },
        });

        if (verifiedCount !== lineIds.length) {
          throw new Error(
            `Not all PR lines were linked successfully for ${groupCode}.`
          );
        }
      }

      // Policy 1.2: every new item gets its own requirement.
      for (const line of plan.newItemLines) {
        const groupCode = makeNewItemGroupCode(line);
        const quantity = new Prisma.Decimal(line.quantity);
        const unitPrice = new Prisma.Decimal(line.estimatedUnitPrice);
        const totalValue = quantity.mul(unitPrice);

        const isEmergency = isEmergencyGroup(
          [line],
          plan.emergencyRule
        );

        let requirement = await tx.requirement.findUnique({
          where: { groupCode },
        });

        if (requirement) {
          const matches =
            requirement.itemCode === null &&
            requirement.plantCode === line.plantCode &&
            requirement.firstCreatedAt.getTime() ===
              line.request.createdAt.getTime() &&
            requirement.firstNeedByDate.getTime() ===
              line.needByDate.getTime() &&
            new Prisma.Decimal(requirement.totalQuantity).equals(quantity) &&
            requirement.valuationUnitPrice !== null &&
            new Prisma.Decimal(requirement.valuationUnitPrice).equals(unitPrice) &&
            requirement.totalValue !== null &&
            new Prisma.Decimal(requirement.totalValue).equals(totalValue) &&
            requirement.isEmergency === isEmergency &&
            requirement.policyVersionId === plan.policy.id;

          if (!matches) {
            throw new Error(
              `Existing new-item requirement ${groupCode} conflicts with the source PR line.`
            );
          }
        } else {
          requirement = await tx.requirement.create({
            data: {
              groupCode,
              itemCode: null,
              plantCode: line.plantCode,
              firstCreatedAt: line.request.createdAt,
              firstNeedByDate: line.needByDate,
              totalQuantity: quantity,
              valuationUnitPrice: unitPrice,
              totalValue,
              isEmergency,
              status: "PENDING",
              policyVersionId: plan.policy.id,
            },
          });

          createdRequirements += 1;
        }

        const currentLine = await tx.purchaseRequestLine.findUnique({
          where: { id: line.id },
          select: { requirementId: true },
        });

        if (
          currentLine.requirementId &&
          currentLine.requirementId !== requirement.id
        ) {
          throw new Error(
            `New-item PR line ${line.prNumber}/${line.lineNumber} is linked to another requirement.`
          );
        }

        if (!currentLine.requirementId) {
          await tx.purchaseRequestLine.update({
            where: { id: line.id },
            data: {
              requirementId: requirement.id,
            },
          });

          linkedLines += 1;
        }
      }

      return {
        createdRequirements,
        linkedLines,
      };
    },
    {
      maxWait: 10000,
      timeout: 120000,
    }
  );
}

async function main() {
  const plan = await buildPlan();

  const newItemLineIds = new Set(
    plan.newItemLines.map((line) => line.id)
  );

  const heldForReview = plan.heldLines.filter(
    (line) => !newItemLineIds.has(line.id)
  );

  const existingItemLineCount = plan.groups.reduce(
    (sum, group) => sum + group.lines.length,
    0
  );

  const errors = validatePlan(plan);

  console.log("\n========== REQUIREMENT CREATION VALIDATION ==========");
  console.log(`Mode: ${APPLY ? "APPLY" : "VALIDATE ONLY"}`);
  console.log(`Policy: ${plan.policy.documentCode} v${plan.policy.version}`);
  console.log(`Policy ID: ${plan.policy.id}`);
  console.log(`Unlinked PR lines inspected: ${plan.prepared.length}`);
  console.log(`Existing-item groups: ${plan.groups.length}`);
  console.log(`Existing-item PR lines: ${existingItemLineCount}`);
  console.log(
    `Standalone new-item requirements: ${plan.newItemLines.length}`
  );
  console.log(`New-item PR lines: ${plan.newItemLines.length}`);
  console.log(`Lines held for review: ${heldForReview.length}`);

  console.log(
    `Total requirements planned: ${
      plan.groups.length + plan.newItemLines.length
    }`
  );

  console.log(
    `Total PR lines to link: ${
      existingItemLineCount + plan.newItemLines.length
    }`
  );

  console.log("\n========== GROUP PREVIEW ==========");

  for (const [index, group] of plan.groups.entries()) {
    const firstLine = group.lines[0];

    console.log(
      [
        `${index + 1}.`,
        makeGroupCode(firstLine),
        `item=${group.itemCode}`,
        `plant=${group.plantCode}`,
        `lines=${group.lines.length}`,
        `quantity=${decimalSum(group.lines).toString()}`,
        `emergency=${
          isEmergencyGroup(group.lines, plan.emergencyRule)
            ? "YES"
            : "NO"
        }`,
      ].join(" | ")
    );
  }

  console.log("\n========== STANDALONE NEW-ITEM PREVIEW ==========");

  for (const line of plan.newItemLines) {
    const quantity = new Prisma.Decimal(line.quantity);
    const unitPrice = new Prisma.Decimal(line.estimatedUnitPrice);

    console.log(
      [
        makeNewItemGroupCode(line),
        `PR=${line.prNumber}`,
        `line=${line.lineNumber}`,
        `description=${line.description}`,
        `plant=${line.plantCode}`,
        `quantity=${quantity.toString()} ${line.uom}`,
        `unitPrice=${unitPrice.toString()}`,
        `totalValue=${quantity.mul(unitPrice).toString()}`,
        `emergency=${
          isEmergencyGroup([line], plan.emergencyRule)
            ? "YES"
            : "NO"
        }`,
      ].join(" | ")
    );
  }

  console.log("\n========== VALIDATION ==========");

  if (errors.length > 0) {
    console.error(`Validation errors: ${errors.length}`);

    for (const error of errors) {
      console.error(`- ${error}`);
    }

    throw new Error(
      "Validation failed. No database writes were performed."
    );
  }

  console.log(
    "All existing-item groups and standalone new items passed validation."
  );

  console.log(
    "New-item requirements will use requester-estimated prices under policy 1.2."
  );

  console.log(
    "Existing-item valuation fields will remain null for the valuation stage."
  );

  console.log(
    `${heldForReview.length} PR line(s) will remain unlinked for review.`
  );

  if (!APPLY) {
    console.log("\nVALIDATION ONLY: no database writes were performed.");
    console.log("Run with --apply only after reviewing this output.");
    return;
  }

  const result = await applyPlan(plan);

  console.log("\n========== CREATION RESULT ==========");
  console.log("Requirements created:", result.createdRequirements);
  console.log("PR lines newly linked:", result.linkedLines);
  console.log("Transaction committed successfully.");
}

main()
  .catch((error) => {
    console.error("\nRequirement creation failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });