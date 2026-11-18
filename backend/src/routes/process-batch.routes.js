import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { importBatchCsv } from "./batch.routes.js";

const router = Router();
const execFileAsync = promisify(execFile);
const backendDirectory = fileURLToPath(new URL("../../", import.meta.url));

async function runScript(scriptName, batchId) {
  const scriptPath = path.join(
    backendDirectory,
    "src",
    "scripts",
    scriptName
  );

  const result = await execFileAsync(
    process.execPath,
    [scriptPath, batchId, "--apply"],
    {
      cwd: backendDirectory,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180000,
    }
  );

  return result.stdout;
}

export function createProcessBatchRouter(prisma) {
  router.post("/", async (req, res) => {
    let importStatus = 200;
    let importResponse;

    const captureResponse = {
      status(code) {
        importStatus = code;
        return this;
      },
      json(payload) {
        importResponse = payload;
        return payload;
      },
    };

    try {
      await importBatchCsv(req, captureResponse, prisma);

      if (!importResponse?.success) {
        return res.status(importStatus).json(importResponse);
      }

      const { batchId } = importResponse.data;

      if (!batchId) {
        return res.status(500).json({
          success: false,
          message: "Import completed without returning a batch ID.",
        });
      }

      console.log(`Processing imported batch ${batchId}`);

      const scriptOutputs = [];

      scriptOutputs.push(
        await runScript("create-requirements.js", batchId)
      );

      scriptOutputs.push(
        await runScript("value-requirements.js", batchId)
      );

      scriptOutputs.push(
        await runScript("process-procurement-decisions.js", batchId)
      );

      const batchFilter = {
        requestLines: {
          some: { batchId },
        },
      };

      const [
        requirementCount,
        decisionCount,
        sourcingRequestCount,
      ] = await Promise.all([
        prisma.requirement.count({
          where: batchFilter,
        }),
        prisma.procurementDecision.count({
          where: {
            requirement: batchFilter,
          },
        }),
        prisma.sourcingRequest.count({
          where: {
            requirement: batchFilter,
          },
        }),
      ]);

      return res.status(200).json({
        success: true,
        message: "Batch imported and processed successfully.",
        data: {
          ...importResponse.data,
          requirementCount,
          decisionCount,
          sourcingRequestCount,
          scriptOutputs,
          purchaseOrdersCreated: 0,
          buyerApprovalRequired: true,
        },
      });
    } catch (error) {
      console.error("Batch processing failed:", error);

      return res.status(500).json({
        success: false,
        message:
          "Batch processing failed. Check backend logs before retrying; some processing steps may already have completed.",
        error: error.message,
      });
    }
  });

  return router;
}
