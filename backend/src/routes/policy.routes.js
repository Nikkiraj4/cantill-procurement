
import express from "express";
import multer from "multer";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" &&
      path.extname(file.originalname).toLowerCase() === ".pdf";

    if (!isPdf) {
      callback(new Error("Only PDF policy documents are accepted."));
      return;
    }

    callback(null, true);
  },
});

const uploadDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/policies"
);

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function readPositiveNumber(value, fieldName) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }

  return number;
}

function readPositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1 || number > 20) {
    throw new Error(`${fieldName} must be a whole number between 1 and 20.`);
  }

  return number;
}

async function extractPdfText(buffer) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const document = await loadingTask.promise;

  try {
    const pages = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      pages.push(
        content.items
          .filter((item) => typeof item.str === "string")
          .map((item) => item.str)
          .join(" ")
      );
    }

    return pages.join("\n\n").trim();
  } finally {
    await loadingTask.destroy();
  }
}

function nextPolicyVersion(currentVersion) {
  const match = String(currentVersion).match(/^(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(
      `Unsupported policy version format: ${currentVersion}`
    );
  }

  let major = Number(match[1]);
  let minor = Number(match[2]) + 1;

  if (minor > 9) {
    major += 1;
    minor = 0;
  }

  return `${major}.${minor}`;
}

function updateRule(rules, ruleCode, update) {
  const rule = rules.find((entry) => entry.ruleCode === ruleCode);

  if (!rule) {
    throw new Error(`Required policy rule not found: ${ruleCode}`);
  }

  update(rule);
}

router.get("/", async (_req, res) => {
  try {
    const policies = await router.prisma.policyVersion.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: {
        _count: {
          select: {
            rules: true,
            decisions: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      data: policies,
    });
  } catch (error) {
    console.error("Policy list error:", error);
    return sendError(res, 500, "Unable to load policy versions.");
  }
});

router.post(
  "/upload",
  (req, res, next) => {
    upload.single("policyPdf")(req, res, (error) => {
      if (error) {
        return sendError(res, 400, error.message);
      }

      next();
    });
  },
  async (req, res) => {
    let savedFilePath = null;

    try {
      if (!req.file) {
        return sendError(res, 400, "Please select a policy PDF.");
      }

      const {
        effectiveFrom,
        changeSummary,
        emergencyLimitINR,
        spotLimitINR,
        rfqLimitINR,
        capexSupplierCount,
        rfqSupplierCount,
        rfpSupplierCount,
      } = req.body;

      if (!effectiveFrom || !changeSummary?.trim()) {
        return sendError(
          res,
          400,
          "Effective date and change summary are required."
        );
      }

      const effectiveDate = new Date(`${effectiveFrom}T00:00:00.000Z`);

      if (
        Number.isNaN(effectiveDate.getTime()) ||
        effectiveDate.toISOString().slice(0, 10) !== effectiveFrom
      ) {
        return sendError(res, 400, "Please provide a valid effective date.");
      }

      const emergencyLimit = readPositiveNumber(
        emergencyLimitINR,
        "Emergency purchase limit"
      );

      const spotLimit = readPositiveNumber(
        spotLimitINR,
        "Spot purchase limit"
      );

      const rfqLimit = readPositiveNumber(
        rfqLimitINR,
        "RFQ upper limit"
      );

      const capexCount = readPositiveInteger(
        capexSupplierCount,
        "Capex supplier count"
      );

      const rfqCount = readPositiveInteger(
        rfqSupplierCount,
        "RFQ supplier count"
      );

      const rfpCount = readPositiveInteger(
        rfpSupplierCount,
        "RFP supplier count"
      );

      if (rfqLimit <= spotLimit) {
        return sendError(
          res,
          400,
          "The RFQ upper limit must be greater than the spot purchase limit."
        );
      }

      const extractedText = await extractPdfText(req.file.buffer);

      if (extractedText.length < 30) {
        return sendError(
          res,
          400,
          "No readable policy text was extracted. Scanned PDFs need OCR before they can be used."
        );
      }

      const activePolicy = await router.prisma.policyVersion.findFirst({
        where: {
          status: "ACTIVE",
          documentCode: "CORVO-PROC-POL-04",
        },
        include: {
          rules: {
            orderBy: { priority: "asc" },
          },
        },
      });

      if (!activePolicy) {
        return sendError(res, 409, "No active procurement policy was found.");
      }

      const existingDraft = await router.prisma.policyVersion.findFirst({
        where: {
          status: "DRAFT",
          documentCode: activePolicy.documentCode,
        },
      });

      if (existingDraft) {
        return sendError(
          res,
          409,
          `Draft policy v${existingDraft.version} already exists. Review or remove that draft before uploading another amendment.`
        );
      }

      const version = nextPolicyVersion(activePolicy.version);

      const rules = activePolicy.rules.map((rule) => ({
        ruleCode: rule.ruleCode,
        section: rule.section,
        priority: rule.priority,
        name: rule.name,
        description: rule.description,
        conditions: rule.conditions,
        outcome: rule.outcome,
        enabled: rule.enabled,
      }));

      updateRule(rules, "DECISION-5.3", (rule) => {
        rule.conditions = {
          ...rule.conditions,
          requirementValueINR: {
            lessThanOrEqualTo: emergencyLimit,
          },
        };
        rule.description =
          `Emergency requirements valued at or below INR ${emergencyLimit.toLocaleString("en-IN")} may use a direct PO when the item has a recent Active-supplier purchase.`;
      });

      updateRule(rules, "DECISION-5.4", (rule) => {
        rule.conditions = {
          ...rule.conditions,
          requirementValueINR: {
            lessThan: spotLimit,
          },
        };
        rule.description =
          `Requirements below INR ${spotLimit.toLocaleString("en-IN")} may use a spot PO when the item has a recent Active-supplier purchase.`;
      });

      updateRule(rules, "DECISION-5.5", (rule) => {
        rule.conditions = {
          requirementValueINR: {
            lessThan: rfqLimit,
          },
        };
        rule.outcome = {
          ...rule.outcome,
          suggestedSupplierCount: rfqCount,
        };
        rule.description =
          `Requirements below INR ${rfqLimit.toLocaleString("en-IN")} that do not match an earlier rule go to RFQ.`;
      });

      updateRule(rules, "DECISION-5.6", (rule) => {
        rule.conditions = {
          requirementValueINR: {
            greaterThanOrEqualTo: rfqLimit,
          },
        };
        rule.outcome = {
          ...rule.outcome,
          suggestedSupplierCount: rfpCount,
        };
        rule.description =
          `Requirements valued at INR ${rfqLimit.toLocaleString("en-IN")} or more go to RFP.`;
      });

      updateRule(rules, "DECISION-5.1", (rule) => {
        rule.outcome = {
          ...rule.outcome,
          suggestedSupplierCount: capexCount,
        };
        rule.description =
          `Capex items go to sourcing with ${capexCount} supplier suggestions and require capex approval.`;
      });

      await mkdir(uploadDirectory, { recursive: true });

      const storedFileName = `policy-${version}-${randomUUID()}.pdf`;
      savedFilePath = path.join(uploadDirectory, storedFileName);

      await writeFile(savedFilePath, req.file.buffer);

      const draft = await router.prisma.policyVersion.create({
        data: {
          version,
          documentCode: activePolicy.documentCode,
          effectiveFrom: effectiveDate,
          status: "DRAFT",
          sourceFileName: req.file.originalname,
          sourceText: extractedText,
          changeSummary: changeSummary.trim(),
          rules: {
            create: rules,
          },
        },
        include: {
          rules: {
            orderBy: { priority: "asc" },
          },
        },
      });

      return res.status(201).json({
        success: true,
        message: `Policy amendment saved as draft v${version}.`,
        data: {
          id: draft.id,
          version: draft.version,
          status: draft.status,
          effectiveFrom: draft.effectiveFrom,
          sourceFileName: draft.sourceFileName,
          changeSummary: draft.changeSummary,
          extractedCharacters: extractedText.length,
          changes: {
            emergencyLimitINR: emergencyLimit,
            spotLimitINR: spotLimit,
            rfqLimitINR: rfqLimit,
            capexSupplierCount: capexCount,
            rfqSupplierCount: rfqCount,
            rfpSupplierCount: rfpCount,
          },
          rulesCopied: draft.rules.length,
        },
      });
    } catch (error) {
      if (savedFilePath) {
        const { unlink } = await import("node:fs/promises");
        await unlink(savedFilePath).catch(() => {});
      }

      if (
        error.message?.includes("must be a positive") ||
        error.message?.includes("must be a whole number") ||
        error.message?.includes("Required policy rule") ||
        error.message?.includes("Unsupported policy version")
      ) {
        return sendError(res, 400, error.message);
      }

      console.error("Policy upload error:", error);
      return sendError(res, 500, "Unable to create policy draft.");
    }
  }
);

router.post("/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const approvedBy = String(req.body?.approvedBy || "").trim();

    if (!approvedBy) {
      return sendError(res, 400, "Approver name is required.");
    }

    const result = await router.prisma.$transaction(async (tx) => {
      const draft = await tx.policyVersion.findUnique({
        where: { id },
      });

      if (!draft || draft.status !== "DRAFT") {
        throw new Error("Only an existing draft policy can be approved.");
      }

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      if (draft.effectiveFrom > today) {
        throw new Error(
          "This policy has a future effective date. It cannot be activated yet."
        );
      }

      const rules = await tx.policyRule.count({
        where: { policyVersionId: draft.id },
      });

      if (rules === 0) {
        throw new Error("The draft has no policy rules.");
      }

      await tx.policyVersion.updateMany({
        where: {
          documentCode: draft.documentCode,
          status: "ACTIVE",
        },
        data: {
          status: "RETIRED",
          effectiveTo: new Date(draft.effectiveFrom.getTime() - 1),
        },
      });

      return tx.policyVersion.update({
        where: { id: draft.id },
        data: {
          status: "ACTIVE",
          approvedBy,
          approvedAt: new Date(),
          activatedAt: new Date(),
        },
      });
    });

    return res.json({
      success: true,
      message: `Policy v${result.version} is now active.`,
      data: result,
    });
  } catch (error) {
    if (
      error.message?.includes("Only an existing draft") ||
      error.message?.includes("future effective date") ||
      error.message?.includes("no policy rules")
    ) {
      return sendError(res, 400, error.message);
    }

    console.error("Policy approval error:", error);
    return sendError(res, 500, "Unable to approve policy.");
  }
});

export function createPolicyRouter(prisma) {
  router.prisma = prisma;
  return router;
}
