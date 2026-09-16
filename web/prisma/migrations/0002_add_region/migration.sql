-- DropIndex
DROP INDEX "check_run_brand_check_name_started_at_idx";

-- DropIndex
DROP INDEX "check_state_brand_check_name_key";

-- AlterTable
ALTER TABLE "check_run" ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'FR';

-- AlterTable
ALTER TABLE "check_state" ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'FR';

-- CreateIndex
CREATE INDEX "check_run_brand_region_check_name_started_at_idx" ON "check_run"("brand", "region", "check_name", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_state_brand_region_check_name_key" ON "check_state"("brand", "region", "check_name");

