-- Specs 034 à 037 : formules d'abonnement, échéance, console de la plateforme, encaissement.
CREATE TYPE "PlanKey" AS ENUM ('essentiel', 'pro', 'premium');
CREATE TYPE "AccountState" AS ENUM ('trial', 'active', 'past_due', 'suspended');
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'orange_money', 'mtn_momo', 'moov_money', 'wave', 'bank_transfer');

ALTER TABLE "Tenant"
  ADD COLUMN "plan" "PlanKey" NOT NULL DEFAULT 'pro',
  ADD COLUMN "accountState" "AccountState" NOT NULL DEFAULT 'trial',
  ADD COLUMN "paidUntil" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "manuallySuspended" BOOLEAN NOT NULL DEFAULT false;

-- Spec 034, Q3 et spec 035, R8 : les comptes existants passent en Pro, actifs, échéance dans 7 jours.
UPDATE "Tenant" SET "plan" = 'pro', "accountState" = 'active', "paidUntil" = CURRENT_TIMESTAMP + interval '7 days';

CREATE TABLE "SubscriptionPayment" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "number" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "reference" TEXT,
  "months" INTEGER NOT NULL,
  "plan" "PlanKey" NOT NULL,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "previousPaidUntil" TIMESTAMPTZ(3) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMPTZ(3),
  "cancelReason" TEXT,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionPayment_number_key" ON "SubscriptionPayment"("number");
CREATE INDEX "SubscriptionPayment_tenantId_createdAt_idx" ON "SubscriptionPayment"("tenantId", "createdAt");
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReceiptCounter" (
  "year" INTEGER NOT NULL,
  "last" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("year")
);

CREATE TABLE "PlatformAdmin" (
  "id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(3),
  "lastLoginAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

CREATE TABLE "PlatformSession" (
  "id" UUID NOT NULL,
  "adminId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformSession_tokenHash_key" ON "PlatformSession"("tokenHash");
ALTER TABLE "PlatformSession" ADD CONSTRAINT "PlatformSession_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PlatformAuditLog" (
  "id" UUID NOT NULL,
  "adminId" UUID NOT NULL,
  "tenantId" UUID,
  "action" TEXT NOT NULL,
  "reason" TEXT,
  "before" JSONB,
  "after" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformAuditLog_tenantId_createdAt_idx" ON "PlatformAuditLog"("tenantId", "createdAt");

CREATE TABLE "PasswordResetToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
