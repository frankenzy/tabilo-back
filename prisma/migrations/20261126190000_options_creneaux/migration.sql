-- Spec 038 : options et suppléments ; spec 039 : créneaux.
ALTER TABLE "MenuItem"
  ADD COLUMN "promoSlots" JSONB,
  ADD COLUMN "promoName" TEXT,
  ADD COLUMN "availabilitySlots" JSONB;

CREATE TABLE "MenuOptionGroup" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "itemId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "multiple" BOOLEAN NOT NULL DEFAULT false,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL,
  CONSTRAINT "MenuOptionGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MenuOptionGroup_itemId_idx" ON "MenuOptionGroup"("itemId");
ALTER TABLE "MenuOptionGroup" ADD CONSTRAINT "MenuOptionGroup_itemId_establishmentId_fkey"
  FOREIGN KEY ("itemId", "establishmentId") REFERENCES "MenuItem"("id", "establishmentId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MenuOption" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL DEFAULT 0,
  "icon" TEXT,
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL,
  CONSTRAINT "MenuOption_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MenuOption_groupId_idx" ON "MenuOption"("groupId");
ALTER TABLE "MenuOption" ADD CONSTRAINT "MenuOption_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "MenuOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceRequestItem" ADD COLUMN "options" JSONB;
