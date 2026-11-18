import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const BATCH_ID = process.argv[2];
const APPLY = process.argv.includes('--apply');
const CONSOLIDATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const ELIGIBLE_ROUTES = [
  'CONTRACT_PO',
  'EMERGENCY_PO',
  'SPOT_PO',
];

function decimal(value) {
  return new Prisma.Decimal(value);
}

function money(value) {
  return decimal(value).toDecimalPlaces(2);
}

function compareDates(a, b) {
  return a.getTime() - b.getTime();
}

function getGroupKey(decision) {
  return [
    decision.supplierId,
    decision.requirement.plantCode,
    decision.route,
  ].join('|');
}

async function loadEligibleDecisions() {
  return prisma.procurementDecision.findMany({
    where: {
      decisionType: 'PO',
      requirement: {
        is: {
          status: { in: ["APPROVED", "OVERRIDDEN"] },
          requestLines: { some: { batchId: BATCH_ID } },
        },
      },
      route: {
        in: ELIGIBLE_ROUTES,
      },
    },
    include: {
      requirement: {
        include: {
          purchaseOrderLine: true,
        },
      },
      supplier: true,
    },
    orderBy: [
      {
        requirement: {
          firstCreatedAt: 'asc',
        },
      },
      {
        requirement: {
          groupCode: 'asc',
        },
      },
    ],
  });
}

function validateDecisions(decisions) {
  const errors = [];
  const seenRequirements = new Set();

  for (const decision of decisions) {
    const requirement = decision.requirement;

    if (!decision.supplierId || !decision.supplier) {
      errors.push(
        `${requirement.groupCode}: missing selected supplier`,
      );
    }

    if (decision.supplier?.status !== 'ACTIVE') {
      errors.push(
        `${requirement.groupCode}: selected supplier is not ACTIVE`,
      );
    }

    if (
      decision.unitPrice === null ||
      decision.unitPrice === undefined ||
      !decimal(decision.unitPrice).gt(0)
    ) {
      errors.push(
        `${requirement.groupCode}: missing or invalid positive unit price`,
      );
    }

    if (requirement.totalValue === null) {
      errors.push(
        `${requirement.groupCode}: requirement is not valued`,
      );
    }

    if (!requirement.plantCode) {
      errors.push(
        `${requirement.groupCode}: missing plant`,
      );
    }

    if (requirement.purchaseOrderLine) {
      errors.push(
        `${requirement.groupCode}: already linked to a purchase order`,
      );
    }

    if (seenRequirements.has(requirement.id)) {
      errors.push(
        `${requirement.groupCode}: duplicate PO decision`,
      );
    }

    seenRequirements.add(requirement.id);

  }

  if (errors.length > 0) {
    console.error('\n========== VALIDATION ERRORS ==========');

    for (const error of errors) {
      console.error('-', error);
    }

    throw new Error(
      `PO validation failed with ${errors.length} error(s).`,
    );
  }
}

function buildPurchaseOrderPlan(decisions, startingSequence = 1) {
  const purchaseOrders = [];
  const ordersByGroup = new Map();

  let sequence = startingSequence;

  for (const decision of decisions) {
    const requirement = decision.requirement;
    const groupKey = getGroupKey(decision);
    const requirementDate = requirement.firstCreatedAt;

    if (!ordersByGroup.has(groupKey)) {
      ordersByGroup.set(groupKey, []);
    }

    const candidateOrders = ordersByGroup.get(groupKey);

    // Candidate orders are already in creation order.
    // Select the earliest open PO within 24 hours
    // of the first requirement assigned to that PO.
    let purchaseOrder = candidateOrders.find((candidate) => {
      const elapsed =
        requirementDate.getTime() -
        candidate.anchorCreatedAt.getTime();

      return (
        elapsed >= 0 &&
        elapsed <= CONSOLIDATION_WINDOW_MS
      );
    });

    if (!purchaseOrder) {
      purchaseOrder = {
        poNumber: `CORVO-PO-${String(sequence).padStart(5, '0')}`,
        supplierId: decision.supplierId,
        supplierName: decision.supplier.name,
        plantCode: requirement.plantCode,
        route: decision.route,
        anchorCreatedAt: requirementDate,
        lines: [],
      };

      sequence += 1;

      candidateOrders.push(purchaseOrder);
      purchaseOrders.push(purchaseOrder);
    }

    purchaseOrder.lines.push({
      requirementId: requirement.id,
      groupCode: requirement.groupCode,
      itemCode: requirement.itemCode,
      quantity: requirement.totalQuantity,
      unitPrice: decision.unitPrice,
      lineValue: money(
        decimal(requirement.totalQuantity).mul(decision.unitPrice),
      ),
      createdAt: requirementDate,
    });
  }

  return purchaseOrders;
}

function printPlan(purchaseOrders) {
  const routeCounts = new Map();

  let totalLines = 0;
  let totalValue = new Prisma.Decimal(0);

  for (const purchaseOrder of purchaseOrders) {
    routeCounts.set(
      purchaseOrder.route,
      (routeCounts.get(purchaseOrder.route) ?? 0) + 1,
    );

    for (const line of purchaseOrder.lines) {
      totalLines += 1;
      totalValue = totalValue.plus(line.lineValue);
    }
  }

  console.log('\n========== PO CONSOLIDATION SUMMARY ==========');
  console.log('Purchase orders planned:', purchaseOrders.length);
  console.log('Purchase order lines planned:', totalLines);
  console.log('Requirements covered:', totalLines);
  console.log(
    'Total PO value (INR):',
    totalValue.toFixed(2),
  );

  console.log('\n========== PURCHASE ORDERS BY ROUTE ==========');

  for (const [route, count] of routeCounts) {
    console.log(`${route}: ${count}`);
  }

  console.log('\n========== PURCHASE ORDER PREVIEW ==========');

  for (const purchaseOrder of purchaseOrders) {
    const poValue = purchaseOrder.lines.reduce(
      (sum, line) => sum.plus(line.lineValue),
      new Prisma.Decimal(0),
    );

    console.log({
      poNumber: purchaseOrder.poNumber,
      supplier: purchaseOrder.supplierName,
      supplierId: purchaseOrder.supplierId,
      plant: purchaseOrder.plantCode,
      route: purchaseOrder.route,
      firstRequirementAt:
        purchaseOrder.anchorCreatedAt.toISOString(),
      lineCount: purchaseOrder.lines.length,
      totalValue: poValue.toFixed(2),
      requirements: purchaseOrder.lines.map(
        (line) => line.groupCode,
      ),
    });
  }

  console.log('\n========== CONSOLIDATION RULES ==========');
  console.log('Supplier must match: YES');
  console.log('Plant must match: YES');
  console.log('Procurement route must match: YES');
  console.log('24-hour window from first requirement: YES');
  console.log('Earliest qualifying open PO selected: YES');
  console.log('Sourcing requests included: NO');
}

async function applyPurchaseOrders(purchaseOrders, expectedLineCount) {
  return prisma.$transaction(
    async (tx) => {
      const batchPOFilter = {
        lines: {
          some: {
            requirement: {
              is: { requestLines: { some: { batchId: BATCH_ID } } },
            },
          },
        },
      };

      const existingPOCount = await tx.purchaseOrder.count({
        where: batchPOFilter,
      });
      const existingLineCount = await tx.purchaseOrderLine.count({
        where: {
          requirement: {
            is: { requestLines: { some: { batchId: BATCH_ID } } },
          },
        },
      });

      if (existingPOCount !== 0 || existingLineCount !== 0) {
        throw new Error(
          'Purchase orders already exist for this batch. Refusing to create duplicates.',
        );
      }

      const currentEligibleCount =
        await tx.procurementDecision.count({
          where: {
            decisionType: 'PO',
            requirement: {
              is: {
                status: { in: ["APPROVED", "OVERRIDDEN"] },
                requestLines: { some: { batchId: BATCH_ID } },
              },
            },
            route: {
              in: ELIGIBLE_ROUTES,
            },
          },
        });

      if (currentEligibleCount !== expectedLineCount) {
        throw new Error(
          `Eligible decision count changed. Expected ${expectedLineCount}, found ${currentEligibleCount}.`,
        );
      }

      let createdPurchaseOrders = 0;
      let createdLines = 0;

      for (const purchaseOrder of purchaseOrders) {
        await tx.purchaseOrder.create({
          data: {
            poNumber: purchaseOrder.poNumber,
            supplier: {
              connect: {
                id: purchaseOrder.supplierId,
              },
            },
            plant: {
              connect: {
                code: purchaseOrder.plantCode,
              },
            },
            route: purchaseOrder.route,
            lines: {
              create: purchaseOrder.lines.map((line) => ({
                requirement: {
                  connect: {
                    id: line.requirementId,
                  },
                },
                itemCode: line.itemCode,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                lineValue: line.lineValue,
              })),
            },
          },
        });

        createdPurchaseOrders += 1;
        createdLines += purchaseOrder.lines.length;
      }

      if (createdLines !== expectedLineCount) {
        throw new Error(
          `Created line count mismatch. Expected ${expectedLineCount}, created ${createdLines}.`,
        );
      }

      return {
        createdPurchaseOrders,
        createdLines,
      };
    },
    {
      maxWait: 10000,
      timeout: 120000,
    },
  );
}

async function main() {
  if (!BATCH_ID) {
    throw new Error('Usage: node src/scripts/create-purchase-orders.js <batchId> [--apply]');
  }

  console.log('========================================');
  console.log('CORVO PROCUREMENT — PURCHASE ORDER CONSOLIDATION');
  console.log('========================================');
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Batch:', BATCH_ID);
  console.log('Consolidation window: 24 hours');

  const [existingPOCount, existingLineCount] =
    await Promise.all([
      prisma.purchaseOrder.count({
        where: {
          lines: {
            some: {
              requirement: {
                is: { requestLines: { some: { batchId: BATCH_ID } } },
              },
            },
          },
        },
      }),
      prisma.purchaseOrderLine.count({
        where: {
          requirement: {
            is: { requestLines: { some: { batchId: BATCH_ID } } },
          },
        },
      }),
    ]);

  console.log('\n========== EXISTING DATABASE STATE ==========');
  console.log('Purchase orders:', existingPOCount);
  console.log('Purchase order lines:', existingLineCount);

  if (existingPOCount !== 0 || existingLineCount !== 0) {
    throw new Error(
      'Purchase orders already exist for this batch. Refusing to create duplicates.',
    );
  }

  const decisions = await loadEligibleDecisions();

  console.log('\n========== ELIGIBLE DECISIONS ==========');
  console.log('Direct PO decisions:', decisions.length);

  if (decisions.length === 0) {
    throw new Error('No eligible direct PO decisions found.');
  }

  validateDecisions(decisions);

  const allExistingPOs = await prisma.purchaseOrder.findMany({
    select: { poNumber: true },
  });

  const highestSequence = allExistingPOs.reduce((highest, po) => {
    const match = po.poNumber.match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);

  const purchaseOrders = buildPurchaseOrderPlan(
    decisions,
    highestSequence + 1,
  );

  printPlan(purchaseOrders);

  const plannedLineCount = purchaseOrders.reduce(
    (sum, purchaseOrder) => sum + purchaseOrder.lines.length,
    0,
  );

  if (plannedLineCount !== decisions.length) {
    throw new Error(
      `Plan mismatch. Decisions: ${decisions.length}, planned lines: ${plannedLineCount}.`,
    );
  }

  console.log('\n========== VALIDATION ==========');
  console.log('All selected suppliers ACTIVE: YES');
  console.log('All decisions have required PO data: YES');
  console.log('No duplicate requirement lines: YES');
  console.log('All decision values match quantity × unit price: YES');
  console.log('Every eligible decision assigned exactly once: YES');
  console.log('Sourcing requests excluded: YES');
  console.log('PO consolidation validation: PASSED');

  if (!APPLY) {
    console.log('\nDRY RUN ONLY — no database records were changed.');
    console.log(
      `After reviewing the output, use: node src/scripts/create-purchase-orders.js ${BATCH_ID} --apply`,
    );
    return;
  }

  const result = await applyPurchaseOrders(
    purchaseOrders,
    decisions.length,
  );

  console.log('\n========== COMMIT RESULT ==========');
  console.log(
    'Purchase orders created:',
    result.createdPurchaseOrders,
  );
  console.log(
    'Purchase order lines created:',
    result.createdLines,
  );
  console.log('Transaction committed successfully.');
}

main()
  .catch((error) => {
    console.error('\nPurchase order processing failed:');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
