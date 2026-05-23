-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "compromisedAt" TIMESTAMP(3),
ADD COLUMN     "compromisedReason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "authLockReason" TEXT,
ADD COLUMN     "authLockedUntil" TIMESTAMP(3);
