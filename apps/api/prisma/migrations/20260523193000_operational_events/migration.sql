-- CreateEnum
CREATE TYPE "OperationalEventType" AS ENUM ('RESERVATION_CREATED', 'RESERVATION_STATUS_UPDATED');

-- CreateEnum
CREATE TYPE "OperationalEventSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AlarmTriageStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'RESOLVED');

-- CreateTable
CREATE TABLE "operational_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reservationId" UUID,
    "eventType" "OperationalEventType" NOT NULL,
    "severity" "OperationalEventSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "triageStatus" "AlarmTriageStatus" NOT NULL DEFAULT 'OPEN',
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" UUID,
    "snoozedUntil" TIMESTAMP(3),
    "assignedUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operational_events_tenantId_eventAt_idx" ON "operational_events"("tenantId", "eventAt");

-- CreateIndex
CREATE INDEX "operational_events_tenantId_severity_triageStatus_eventAt_idx" ON "operational_events"("tenantId", "severity", "triageStatus", "eventAt");

-- CreateIndex
CREATE INDEX "operational_events_tenantId_reservationId_eventAt_idx" ON "operational_events"("tenantId", "reservationId", "eventAt");

-- AddForeignKey
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
