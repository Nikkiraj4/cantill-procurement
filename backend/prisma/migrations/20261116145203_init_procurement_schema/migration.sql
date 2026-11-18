-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ContractSource" AS ENUM ('REGISTER', 'SIGNED_PDF');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('PENDING', 'DECIDED', 'APPROVED', 'OVERRIDDEN', 'REJECTED', 'NOT_PROCESSED');

-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('PO', 'SOURCING_REQUEST', 'NOT_PROCESSED');

-- CreateEnum
CREATE TYPE "ProcurementRoute" AS ENUM ('CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO', 'RFQ', 'RFP', 'CAPEX_SOURCING', 'NEW_ITEM_SOURCING', 'NOT_PROCESSED');

-- CreateEnum
CREATE TYPE "BuyerActionType" AS ENUM ('APPROVE', 'OVERRIDE', 'REJECT');

-- CreateEnum
CREATE TYPE "SourcingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Plant" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Plant_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Item" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "standardPrice" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "status" TEXT NOT NULL,
    "onTimePct" DECIMAL(5,2),
    "qualityRating" DECIMAL(4,2),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCategory" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "SupplierCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "valueCap" DECIMAL(16,2) NOT NULL,
    "consumedValue" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "source" "ContractSource" NOT NULL,
    "sourceFileName" TEXT,
    "signedDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractLine" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "ContractLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseHistory" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "poDate" DATE NOT NULL,
    "supplierId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "quantity" DECIMAL(16,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "plantCode" TEXT NOT NULL,
    "deliveredOnTime" BOOLEAN,

    CONSTRAINT "PurchaseHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "documentCode" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceFileName" TEXT,
    "sourceText" TEXT,
    "changeSummary" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyRule" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "conditions" JSONB NOT NULL,
    "outcome" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PRBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileChecksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IMPORTED',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedBy" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PRBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "prNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "requester" TEXT NOT NULL,
    "department" TEXT,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "requestId" TEXT,
    "prNumber" TEXT NOT NULL,
    "lineNumber" TEXT NOT NULL,
    "plantCode" TEXT NOT NULL,
    "itemCode" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(16,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "estimatedUnitPrice" DECIMAL(14,2),
    "needByDate" DATE NOT NULL,
    "urgency" TEXT NOT NULL,
    "rawData" JSONB,
    "requirementId" TEXT,

    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "groupCode" TEXT NOT NULL,
    "itemCode" TEXT,
    "plantCode" TEXT NOT NULL,
    "firstCreatedAt" TIMESTAMP(3) NOT NULL,
    "firstNeedByDate" DATE NOT NULL,
    "totalQuantity" DECIMAL(16,4) NOT NULL,
    "valuationUnitPrice" DECIMAL(14,2),
    "totalValue" DECIMAL(16,2),
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "status" "RequirementStatus" NOT NULL DEFAULT 'PENDING',
    "policyVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementDecision" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "decisionType" "DecisionType" NOT NULL,
    "route" "ProcurementRoute" NOT NULL,
    "supplierId" TEXT,
    "unitPrice" DECIMAL(14,2),
    "groupValue" DECIMAL(16,2),
    "appliedClause" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionSupplierSuggestion" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "reason" TEXT,

    CONSTRAINT "DecisionSupplierSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "plantCode" TEXT NOT NULL,
    "route" "ProcurementRoute" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "itemCode" TEXT,
    "quantity" DECIMAL(16,4) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "lineValue" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcingRequest" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "status" "SourcingStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourcingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreferredSupplierSnapshot" (
    "id" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "asOfDate" DATE NOT NULL,
    "policyVersionId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreferredSupplierSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreferredSupplierEntry" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DECIMAL(8,4) NOT NULL,
    "referencePrice" DECIMAL(14,2),
    "explanation" JSONB NOT NULL,
    "itemCode" TEXT NOT NULL,

    CONSTRAINT "PreferredSupplierEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerAction" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "action" "BuyerActionType" NOT NULL,
    "comment" TEXT,
    "performedBy" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "requester" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "extractedData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierCategory_category_idx" ON "SupplierCategory"("category");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCategory_supplierId_category_key" ON "SupplierCategory"("supplierId", "category");

-- CreateIndex
CREATE INDEX "Contract_supplierId_startDate_endDate_idx" ON "Contract"("supplierId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "ContractLine_itemCode_idx" ON "ContractLine"("itemCode");

-- CreateIndex
CREATE UNIQUE INDEX "ContractLine_contractId_itemCode_key" ON "ContractLine"("contractId", "itemCode");

-- CreateIndex
CREATE INDEX "PurchaseHistory_itemCode_poDate_idx" ON "PurchaseHistory"("itemCode", "poDate");

-- CreateIndex
CREATE INDEX "PurchaseHistory_supplierId_itemCode_poDate_idx" ON "PurchaseHistory"("supplierId", "itemCode", "poDate");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_version_key" ON "PolicyVersion"("version");

-- CreateIndex
CREATE INDEX "PolicyVersion_status_effectiveFrom_idx" ON "PolicyVersion"("status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PolicyRule_policyVersionId_priority_idx" ON "PolicyRule"("policyVersionId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyRule_policyVersionId_ruleCode_key" ON "PolicyRule"("policyVersionId", "ruleCode");

-- CreateIndex
CREATE INDEX "PurchaseRequest_prNumber_idx" ON "PurchaseRequest"("prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_batchId_prNumber_key" ON "PurchaseRequest"("batchId", "prNumber");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_plantCode_itemCode_idx" ON "PurchaseRequestLine"("plantCode", "itemCode");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_prNumber_lineNumber_idx" ON "PurchaseRequestLine"("prNumber", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequestLine_batchId_prNumber_lineNumber_key" ON "PurchaseRequestLine"("batchId", "prNumber", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Requirement_groupCode_key" ON "Requirement"("groupCode");

-- CreateIndex
CREATE INDEX "Requirement_itemCode_plantCode_firstCreatedAt_idx" ON "Requirement"("itemCode", "plantCode", "firstCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementDecision_requirementId_key" ON "ProcurementDecision"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionSupplierSuggestion_decisionId_supplierId_key" ON "DecisionSupplierSuggestion"("decisionId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionSupplierSuggestion_decisionId_rank_key" ON "DecisionSupplierSuggestion"("decisionId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_plantCode_route_createdAt_idx" ON "PurchaseOrder"("supplierId", "plantCode", "route", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_requirementId_key" ON "PurchaseOrderLine"("requirementId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SourcingRequest_requirementId_key" ON "SourcingRequest"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "PreferredSupplierSnapshot_itemCode_asOfDate_key" ON "PreferredSupplierSnapshot"("itemCode", "asOfDate");

-- CreateIndex
CREATE UNIQUE INDEX "PreferredSupplierEntry_snapshotId_supplierId_key" ON "PreferredSupplierEntry"("snapshotId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PreferredSupplierEntry_snapshotId_rank_key" ON "PreferredSupplierEntry"("snapshotId", "rank");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_createdAt_idx" ON "AuditEvent"("entityType", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "SupplierCategory" ADD CONSTRAINT "SupplierCategory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractLine" ADD CONSTRAINT "ContractLine_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractLine" ADD CONSTRAINT "ContractLine_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseHistory" ADD CONSTRAINT "PurchaseHistory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseHistory" ADD CONSTRAINT "PurchaseHistory_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseHistory" ADD CONSTRAINT "PurchaseHistory_plantCode_fkey" FOREIGN KEY ("plantCode") REFERENCES "Plant"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyRule" ADD CONSTRAINT "PolicyRule_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PRBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PRBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_plantCode_fkey" FOREIGN KEY ("plantCode") REFERENCES "Plant"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_plantCode_fkey" FOREIGN KEY ("plantCode") REFERENCES "Plant"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementDecision" ADD CONSTRAINT "ProcurementDecision_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementDecision" ADD CONSTRAINT "ProcurementDecision_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementDecision" ADD CONSTRAINT "ProcurementDecision_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionSupplierSuggestion" ADD CONSTRAINT "DecisionSupplierSuggestion_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ProcurementDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionSupplierSuggestion" ADD CONSTRAINT "DecisionSupplierSuggestion_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_plantCode_fkey" FOREIGN KEY ("plantCode") REFERENCES "Plant"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcingRequest" ADD CONSTRAINT "SourcingRequest_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreferredSupplierSnapshot" ADD CONSTRAINT "PreferredSupplierSnapshot_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreferredSupplierSnapshot" ADD CONSTRAINT "PreferredSupplierSnapshot_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreferredSupplierEntry" ADD CONSTRAINT "PreferredSupplierEntry_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PreferredSupplierSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreferredSupplierEntry" ADD CONSTRAINT "PreferredSupplierEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreferredSupplierEntry" ADD CONSTRAINT "PreferredSupplierEntry_itemCode_fkey" FOREIGN KEY ("itemCode") REFERENCES "Item"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerAction" ADD CONSTRAINT "BuyerAction_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ProcurementDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
