import express from "express";
import cors from "cors";
import helmet from "helmet";
import { PrismaClient } from "@prisma/client";
import { createDashboardRouter } from "./routes/dashboard.routes.js";
import { createBatchRouter } from "./routes/batch.routes.js";
import { createPolicyRouter } from "./routes/policy.routes.js";
import { createProcessBatchRouter } from "./routes/process-batch.routes.js";
import { createBuyerRouter } from "./routes/buyer.routes.js";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT) || 5000;
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(
  express.text({
    type: ["text/csv", "text/plain"],
    limit: "10mb",
  })
);

app.use("/api/policies", createPolicyRouter(prisma));
app.use("/api/dashboard", createDashboardRouter(prisma));
app.use("/api/batches", createBatchRouter(prisma));
app.use("/api/process-batch", createProcessBatchRouter(prisma));
app.use("/api/buyer", createBuyerRouter(prisma));

app.get("/", (_req, res) => {
  res.json({
    name: "Cantill Procurement API",
    status: "running",
    version: "1.0.0",
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      success: true,
      message: "API and database are working.",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Health check database error:", error);

    res.status(503).json({
      success: false,
      message: "API is running, but the database is unavailable.",
      database: "disconnected",
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled API error:", error);

  res.status(500).json({
    success: false,
    message: "An unexpected API error occurred.",
  });
});

const server = app.listen(PORT, () => {
  console.log("======================================");
  console.log("CANTILL PROCUREMENT API");
  console.log("======================================");
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

async function shutdown() {
  console.log("\nShutting down API server...");

  server.close(async () => {
    await prisma.$disconnect();
    console.log("Database connection closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
