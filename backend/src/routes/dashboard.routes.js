import { Router } from "express";

const router = Router();

const requirementStatuses = [
  "PENDING",
  "DECIDED",
  "APPROVED",
  "OVERRIDDEN",
  "REJECTED",
  "NOT_PROCESSED",
];

router.get("/summary", async (_req, res) => {
  const [
    batchCount,
    requestCount,
    requirementCount,
    decisionCount,
    poCount,
    sourcingCount,
    requirementValue,
    poValue,
    decisionsByRoute,
    activePolicy,
  ] = await Promise.all([
    router.prisma.pRBatch.count(),
    router.prisma.purchaseRequest.count(),
    router.prisma.requirement.count(),
    router.prisma.procurementDecision.count(),
    router.prisma.purchaseOrder.count(),
    router.prisma.sourcingRequest.count(),
    router.prisma.requirement.aggregate({
      _sum: { totalValue: true },
    }),
    router.prisma.purchaseOrderLine.aggregate({
      _sum: { lineValue: true },
    }),
    router.prisma.procurementDecision.groupBy({
      by: ["route"],
      _count: { _all: true },
    }),
    router.prisma.policyVersion.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { effectiveFrom: "desc" },
      select: {
        version: true,
        documentCode: true,
        effectiveFrom: true,
        status: true,
      },
    }),
  ]);

  res.json({
    success: true,
    data: {
      batches: batchCount,
      purchaseRequests: requestCount,
      requirements: requirementCount,
      decisions: decisionCount,
      purchaseOrders: poCount,
      sourcingRequests: sourcingCount,
      totalRequirementValue: requirementValue._sum.totalValue ?? 0,
      totalPurchaseOrderValue: poValue._sum.lineValue ?? 0,
      decisionsByRoute: decisionsByRoute.map((entry) => ({
        route: entry.route,
        count: entry._count._all,
      })),
      activePolicy,
    },
  });
});

router.get("/requirements", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20),
  );

  const status =
    typeof req.query.status === "string" ? req.query.status : undefined;

  const search =
    typeof req.query.search === "string" ? req.query.search.trim() : "";

  if (status && !requirementStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid requirement status.",
      allowedStatuses: requirementStatuses,
    });
  }

  const where = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { groupCode: { contains: search, mode: "insensitive" } },
            { itemCode: { contains: search, mode: "insensitive" } },
            {
              item: {
                is: {
                  description: { contains: search, mode: "insensitive" },
                },
              },
            },
            {
              requestLines: {
                some: {
                  OR: [
                    { prNumber: { contains: search, mode: "insensitive" } },
                    { description: { contains: search, mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, requirements] = await Promise.all([
    router.prisma.requirement.count({ where }),
    router.prisma.requirement.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { firstCreatedAt: "desc" },
      include: {
        item: true,
        plant: true,
        policyVersion: {
          select: { version: true, documentCode: true },
        },
        decision: {
          include: {
            supplier: true,
            suggestions: {
              include: { supplier: true },
              orderBy: { rank: "asc" },
            },
            overrides: {
              orderBy: { performedAt: "desc" },
            },
          },
        },
        requestLines: {
          include: {
            request: {
              select: {
                prNumber: true,
                requester: true,
                department: true,
                createdAt: true,
              },
            },
          },
          orderBy: [{ prNumber: "asc" }, { lineNumber: "asc" }],
        },
        purchaseOrderLine: {
          include: {
            purchaseOrder: {
              include: { supplier: true, plant: true },
            },
          },
        },
        sourcingRequest: true,
      },
    }),
  ]);

  res.json({
    success: true,
    data: requirements,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

router.get("/purchase-orders", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20),
  );

  const [total, purchaseOrders] = await Promise.all([
    router.prisma.purchaseOrder.count(),
    router.prisma.purchaseOrder.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        supplier: true,
        plant: true,
        lines: {
          include: {
            requirement: {
              include: { item: true, decision: true },
            },
          },
        },
      },
    }),
  ]);

  res.json({
    success: true,
    data: purchaseOrders,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

router.get("/sourcing-requests", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20),
  );

  const [total, sourcingRequests] = await Promise.all([
    router.prisma.sourcingRequest.count(),
    router.prisma.sourcingRequest.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        requirement: {
          include: {
            item: true,
            plant: true,
            decision: {
              include: { suggestions: { include: { supplier: true } } },
            },
            requestLines: {
              include: {
                request: {
                  select: { prNumber: true, requester: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  res.json({
    success: true,
    data: sourcingRequests,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

router.get("/batches", async (_req, res) => {
  const batches = await router.prisma.pRBatch.findMany({
    orderBy: { importedAt: "desc" },
    include: {
      _count: {
        select: { requests: true, lines: true },
      },
    },
  });

  res.json({
    success: true,
    data: batches,
  });
});

export function createDashboardRouter(prisma) {
  router.prisma = prisma;
  return router;
}
