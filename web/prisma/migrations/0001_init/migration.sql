-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "check_run" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "check_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "error" TEXT,
    "screenshot" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_state" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "check_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "last_notified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_run_brand_check_name_started_at_idx" ON "check_run"("brand", "check_name", "started_at");

-- CreateIndex
CREATE INDEX "check_run_started_at_idx" ON "check_run"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_state_brand_check_name_key" ON "check_state"("brand", "check_name");

