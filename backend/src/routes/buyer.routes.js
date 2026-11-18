import express from "express";
import { Prisma } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const router = express.Router();
const execFileAsync = promisify(execFile);

const backendDirectory = fileURLToPath(
  new URL("../../", import.meta.url)
);

const PO_ROUTES = ["CONTRACT_PO", "EMERGENCY_PO", "SPOT_PO"];

const SOURCING_ROUTES = [
  "RFQ",
  "RFP",
  "CAPEX_SOURCING",
  "NEW_ITEM_SOURCING",
];

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

async function runPurchaseOrderScript(batchId) {
  const scriptPath = path.join(
    backendDirectory,
    "src",
    "scripts",
    "create-purchase-orders.js"
  );

  return execFileAsync(
    process.execPath,
    [scriptPath, batchId, "--apply"],
    {
      cwd: backendDirectory,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180000,
    }
  );
}

export function createBuyerRouter(prisma) {
  router.post("/requirements/:requirementId/action", async (req, res) => {
    const requirementId = String(req.params.requirementId || "").trim();
    const action = String(req.body?.action || "").trim().toUpperCase();
    const performedBy = String(req.body?.performedBy || "").trim();
    const comment = String(req.body?.comment || "").trim();

    if (!requirementId) {
      return sendError(res, 400, "Requirement ID is required.");
    }

    if (!["APPROVE", "REJECT", "OVERRIDE"].includes(action)) {
      return sendError(res, 400, "Choose APPROVE, REJECT or OVERRIDE.");
    }

    if (!performedBy) {
      return sendError(res, 400, "Enter the buyer name.");
    }

    if (action === "OVERRIDE" && !comment) {
      return sendError(res, 400, "A comment is required for an override.");
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const requirement = await tx.requirement.findUnique({
          where: { id: requirementId },
          include: {
            decision: {
              include: {
                supplier: true,
                suggestions: {
                  include: { supplier: true },
                  orderBy: { rank: "asc" },
                },
              },
            },
          },
        });

        if (!requirement || !requirement.decision) {
          throw new Error("Requirement or procurement decision was not found.");
        }

        if (requirement.status !== "DECIDED") {
          throw new Error(
            `This requirement has already been reviewed. Current status: ${requirement.status}.`
          );
        }

        const decision = requirement.decision;

        if (decision.decisionType === "NOT_PROCESSED") {
          throw new Error("A NOT_PROCESSED decision cannot be reviewed.");
        }

        let nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
        let updatedDecision = decision;

        if (action === "OVERRIDE") {
          const route = String(req.body?.route || "").trim().toUpperCase();

          if (![...PO_ROUTES, ...SOURCING_ROUTES].includes(route)) {
            throw new Error("Choose a valid procurement route for the override.");
          }

          if (PO_ROUTES.includes(route)) {
            const supplierId = String(req.body?.supplierId || "").trim();
            const unitPrice = Number(req.body?.unitPrice);

            if (!supplierId) {
              throw new Error("Select a supplier for a direct-PO override.");
            }

            if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
              throw new Error("Enter a valid positive unit price.");
            }

            const supplier = await tx.supplier.findUnique({
              where: { id: supplierId },
            });

            if (!supplier || supplier.status !== "ACTIVE") {
              throw new Error("The selected supplier must be ACTIVE.");
            }

            if (!requirement.totalQuantity || Number(requirement.totalQuantity) <= 0) {
              throw new Error("The requirement quantity must be positive.");
            }

            const price = new Prisma.Decimal(String(unitPrice));

            updatedDecision = await tx.procurementDecision.update({
              where: { id: decision.id },
              data: {
                decisionType: "PO",
                route,
                supplierId,
                unitPrice: price,
                groupValue: requirement.totalValue,
              },
            });

            await tx.sourcingRequest.updateMany({
              where: { requirementId },
              data: { status: "CANCELLED" },
            });
          } else {
            updatedDecision = await tx.procurementDecision.update({
              where: { id: decision.id },
              data: {
                decisionType: "SOURCING_REQUEST",
                route,
                supplierId: null,
                unitPrice: null,
                groupValue: requirement.totalValue,
              },
            });

            await tx.sourcingRequest.upsert({
              where: { requirementId },
              create: {
                requirementId,
                status: "OPEN",
              },
              update: {
                status: "OPEN",
              },
            });
          }

          nextStatus = "OVERRIDDEN";
        }

        const buyerAction = await tx.buyerAction.create({
          data: {
            decisionId: decision.id,
            action,
            comment: comment || null,
            performedBy,
          },
        });

        await tx.requirement.update({
          where: { id: requirementId },
          data: { status: nextStatus },
        });

        await tx.auditEvent.create({
          data: {
            entityType: "REQUIREMENT",
            entityId: requirementId,
            action: `BUYER_${action}`,
            actor: performedBy,
            details: {
              comment: comment || null,
              previousRoute: decision.route,
              resultingRoute: updatedDecision.route,
              resultingDecisionType: updatedDecision.decisionType,
              resultingStatus: nextStatus,
            },
          },
        });

        return {
          action: buyerAction,
          status: nextStatus,
          decision: updatedDecision,
        };
      });

      return res.status(200).json({
        success: true,
        message: `Buyer ${action.toLowerCase()} recorded successfully.`,
        data: result,
      });
    } catch (error) {
      const clientError = [
        "Requirement or procurement decision was not found.",
        "This requirement has already been reviewed.",
        "A NOT_PROCESSED decision cannot be reviewed.",
        "Choose a valid procurement route for the override.",
        "Select a supplier for a direct-PO override.",
        "Enter a valid positive unit price.",
        "The selected supplier must be ACTIVE.",
        "The requirement quantity must be positive.",
        "A comment is required for an override.",
      ].some((message) => error.message.startsWith(message));

      console.error("Buyer action failed:", error);

      return sendError(res, clientError ? 400 : 500, error.message);
    }
  });

  router.post("/batches/:batchId/generate-purchase-orders", async (req, res) => {
    const batchId = String(req.params.batchId || "").trim();

    if (!batchId) {
      return sendError(res, 400, "Batch ID is required.");
    }

    try {
      const decisions = await prisma.procurementDecision.findMany({
        where: {
          decisionType: "PO",
          route: { in: PO_ROUTES },
          requirement: {
            is: {
              requestLines: {
                some: { batchId },
              },
            },
          },
        },
        select: {
          id: true,
          requirement: {
            select: {
              status: true,
              groupCode: true,
            },
          },
        },
      });

      if (decisions.length === 0) {
        return sendError(
          res,
          400,
          "This batch has no direct-PO decisions to generate."
        );
      }

      const pending = decisions.filter(
        (decision) => decision.requirement.status === "DECIDED"
      );

      if (pending.length > 0) {
        return sendError(
          res,
          409,
          `${pending.length} direct-PO decision(s) still need buyer review.`
        );
      }

      const eligible = decisions.filter((decision) =>
        ["APPROVED", "OVERRIDDEN"].includes(decision.requirement.status)
      );

      if (eligible.length === 0) {
        return sendError(
          res,
          400,
          "There are no approved direct-PO decisions in this batch."
        );
      }

      const result = await runPurchaseOrderScript(batchId);

      return res.status(200).json({
        success: true,
        message: "Purchase orders generated from approved buyer decisions.",
        data: {
          batchId,
          eligibleDecisionCount: eligible.length,
          output: result.stdout,
        },
      });
    } catch (error) {
      console.error("Buyer PO generation failed:", error);

      return res.status(500).json({
        success: false,
        message: "Purchase-order generation failed.",
        error: error.stderr || error.message,
      });
    }
  });

  return router;
}
