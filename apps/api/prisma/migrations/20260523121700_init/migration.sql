-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('FCM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationErrorCategory" AS ENUM ('TRANSIENT', 'PERMANENT');

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "errorCategory" "NotificationErrorCategory",
    "errorMessage" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "queueJobId" TEXT NOT NULL,
    "queueJobName" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "providerPayload" JSONB,
    "providerResponse" JSONB,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_tenantId_reservationId_createdAt_idx" ON "notification_deliveries"("tenantId", "reservationId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenantId_queueJobId_channel_status_idx" ON "notification_deliveries"("tenantId", "queueJobId", "channel", "status");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
