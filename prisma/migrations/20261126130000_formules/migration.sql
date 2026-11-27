-- Spec 032 : formules (packs).
ALTER TABLE "MenuItem" ADD COLUMN "isBundle" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MenuBundleGroup" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "establishmentId" UUID NOT NULL,
  "bundleId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "choiceIds" UUID[],
  CONSTRAINT "MenuBundleGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MenuBundleGroup_bundleId_idx" ON "MenuBundleGroup"("bundleId");
ALTER TABLE "MenuBundleGroup" ADD CONSTRAINT "MenuBundleGroup_bundleId_establishmentId_fkey"
  FOREIGN KEY ("bundleId", "establishmentId") REFERENCES "MenuItem"("id", "establishmentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- R5 : choix figés sur la ligne de commande.
ALTER TABLE "ServiceRequestItem" ADD COLUMN "choices" JSONB;
