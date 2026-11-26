-- Spec 043 : fidélité par tampons, sans compte.
ALTER TABLE "TableSession" ADD COLUMN "loyaltyCardId" UUID;

CREATE TABLE "LoyaltyProgram" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "stampsRequired" INTEGER NOT NULL,
  "minOrderMinor" INTEGER NOT NULL DEFAULT 0,
  "rewardItemId" UUID NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LoyaltyProgram_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyProgram_establishmentId_key" ON "LoyaltyProgram"("establishmentId");

CREATE TABLE "LoyaltyCard" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "stamps" INTEGER NOT NULL DEFAULT 0,
  "rewardsRedeemed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyCard_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyCard_tokenHash_key" ON "LoyaltyCard"("tokenHash");
CREATE INDEX "LoyaltyCard_establishmentId_idx" ON "LoyaltyCard"("establishmentId");

CREATE TABLE "LoyaltyStamp" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "cardId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyStamp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyStamp_sessionId_key" ON "LoyaltyStamp"("sessionId");
CREATE INDEX "LoyaltyStamp_cardId_idx" ON "LoyaltyStamp"("cardId");

CREATE TABLE "LoyaltyRedemption" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "cardId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "tableId" UUID NOT NULL,
  "rewardItemId" UUID NOT NULL,
  "requestId" UUID,
  "validatedAt" TIMESTAMPTZ(3),
  "validatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyRedemption_sessionId_key" ON "LoyaltyRedemption"("sessionId");
CREATE INDEX "LoyaltyRedemption_establishmentId_validatedAt_idx" ON "LoyaltyRedemption"("establishmentId", "validatedAt");
