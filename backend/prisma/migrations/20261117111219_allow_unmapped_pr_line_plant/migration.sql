-- DropForeignKey
ALTER TABLE "PurchaseRequestLine" DROP CONSTRAINT "PurchaseRequestLine_plantCode_fkey";

-- AlterTable
ALTER TABLE "PurchaseRequestLine" ALTER COLUMN "plantCode" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_plantCode_fkey" FOREIGN KEY ("plantCode") REFERENCES "Plant"("code") ON DELETE SET NULL ON UPDATE CASCADE;
