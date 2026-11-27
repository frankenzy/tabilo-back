-- Spec 033 : prix promotionnel et geste « Offert ».
ALTER TABLE "MenuItem" ADD COLUMN "promoPriceMinor" INTEGER;

-- R1 et R7 : prix de la carte quand la ligne est commandée en promotion (posé à l'insertion : la ligne reste figée).
ALTER TABLE "ServiceRequestItem" ADD COLUMN "listPriceMinor" INTEGER;

-- R4 et R5 : lignes offertes, à part — la ligne de commande est append-only (spec 001).
CREATE TABLE "ServiceRequestItemOffer" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "itemId" UUID NOT NULL,
  "offeredById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceRequestItemOffer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceRequestItemOffer_itemId_key" ON "ServiceRequestItemOffer"("itemId");
CREATE INDEX "ServiceRequestItemOffer_requestId_idx" ON "ServiceRequestItemOffer"("requestId");
ALTER TABLE "ServiceRequestItemOffer" ADD CONSTRAINT "ServiceRequestItemOffer_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "ServiceRequestItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
