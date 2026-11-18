/*
  Warnings:

  - A unique constraint covering the columns `[itemCode,asOfDate,policyVersionId]` on the table `PreferredSupplierSnapshot` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "PreferredSupplierSnapshot_itemCode_asOfDate_key";

-- CreateIndex
CREATE UNIQUE INDEX "PreferredSupplierSnapshot_itemCode_asOfDate_policyVersionId_key" ON "PreferredSupplierSnapshot"("itemCode", "asOfDate", "policyVersionId");
