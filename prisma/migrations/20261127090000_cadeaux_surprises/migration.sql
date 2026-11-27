-- Spec 046 : cadeaux surprises, tirés au sort par le serveur, à déballer.
CREATE TYPE "LoyaltyMode" AS ENUM ('classic', 'surprise');
CREATE TYPE "LoyaltyPrizeKind" AS ENUM ('menu_item', 'free');

ALTER TABLE "LoyaltyProgram"
  ADD COLUMN "mode" "LoyaltyMode" NOT NULL DEFAULT 'classic',
  ADD COLUMN "surpriseMin" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "surpriseMax" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "giftValidityDays" INTEGER NOT NULL DEFAULT 30,
  ALTER COLUMN "stampsRequired" SET DEFAULT 10,
  ALTER COLUMN "rewardItemId" DROP NOT NULL;

ALTER TABLE "LoyaltyCard" ADD COLUMN "nextGiftAt" INTEGER;

CREATE TABLE "LoyaltyPrize" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "kind" "LoyaltyPrizeKind" NOT NULL,
  "menuItemId" UUID,
  "name" TEXT NOT NULL,
  "imageId" UUID,
  "weight" INTEGER NOT NULL,
  "monthlyStock" INTEGER,
  "position" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyPrize_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyPrize_imageId_key" ON "LoyaltyPrize"("imageId");
CREATE INDEX "LoyaltyPrize_establishmentId_archivedAt_idx" ON "LoyaltyPrize"("establishmentId", "archivedAt");
ALTER TABLE "LoyaltyPrize" ADD CONSTRAINT "LoyaltyPrize_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MenuImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LoyaltyPrizeDraw" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "prizeId" UUID NOT NULL,
  "month" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "LoyaltyPrizeDraw_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyPrizeDraw_prizeId_month_key" ON "LoyaltyPrizeDraw"("prizeId", "month");
CREATE INDEX "LoyaltyPrizeDraw_establishmentId_idx" ON "LoyaltyPrizeDraw"("establishmentId");

CREATE TABLE "LoyaltyGift" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "cardId" UUID NOT NULL,
  "prizeId" UUID NOT NULL,
  "unlockSessionId" UUID NOT NULL,
  "atStamp" INTEGER NOT NULL,
  "unlockedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revealedAt" TIMESTAMPTZ(3),
  "celebratedAt" TIMESTAMPTZ(3),
  "useSessionId" UUID,
  "tableId" UUID,
  "requestedAt" TIMESTAMPTZ(3),
  "usedAt" TIMESTAMPTZ(3),
  "usedById" UUID,
  "requestId" UUID,
  CONSTRAINT "LoyaltyGift_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoyaltyGift_unlockSessionId_key" ON "LoyaltyGift"("unlockSessionId");
CREATE UNIQUE INDEX "LoyaltyGift_useSessionId_key" ON "LoyaltyGift"("useSessionId");
CREATE INDEX "LoyaltyGift_cardId_idx" ON "LoyaltyGift"("cardId");
CREATE INDEX "LoyaltyGift_establishmentId_requestedAt_idx" ON "LoyaltyGift"("establishmentId", "requestedAt");
