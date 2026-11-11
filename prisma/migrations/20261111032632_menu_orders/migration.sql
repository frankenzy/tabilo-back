-- CreateEnum
CREATE TYPE "RequestTypeKind" AS ENUM ('service', 'order');

-- AlterTable
ALTER TABLE "Establishment" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'XOF';

-- AlterTable
ALTER TABLE "RequestType" ADD COLUMN     "kind" "RequestTypeKind" NOT NULL DEFAULT 'service';

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "totalMinor" INTEGER;

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "establishmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "establishmentId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "imageId" UUID,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuImage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "establishmentId" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequestItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "establishmentId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ServiceRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuCategory_establishmentId_archivedAt_idx" ON "MenuCategory"("establishmentId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_id_establishmentId_key" ON "MenuCategory"("id", "establishmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_imageId_key" ON "MenuItem"("imageId");

-- CreateIndex
CREATE INDEX "MenuItem_establishmentId_archivedAt_idx" ON "MenuItem"("establishmentId", "archivedAt");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_id_establishmentId_key" ON "MenuItem"("id", "establishmentId");

-- CreateIndex
CREATE INDEX "MenuImage_establishmentId_idx" ON "MenuImage"("establishmentId");

-- CreateIndex
CREATE INDEX "ServiceRequestItem_requestId_idx" ON "ServiceRequestItem"("requestId");

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "Establishment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "Establishment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_establishmentId_fkey" FOREIGN KEY ("categoryId", "establishmentId") REFERENCES "MenuCategory"("id", "establishmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MenuImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestItem" ADD CONSTRAINT "ServiceRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cohérence des montants et des quantités.
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_price_positive" CHECK ("priceMinor" >= 0);
ALTER TABLE "ServiceRequestItem"
  ADD CONSTRAINT "ServiceRequestItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 50),
  ADD CONSTRAINT "ServiceRequestItem_price_positive" CHECK ("unitPriceMinor" >= 0);

-- Un seul type « commande » actif par établissement.
CREATE UNIQUE INDEX "RequestType_one_order_type_key"
  ON "RequestType" ("establishmentId") WHERE "kind" = 'order' AND "archivedAt" IS NULL;

-- Les établissements existants reçoivent leur type « Commande ».
INSERT INTO "RequestType" ("id", "tenantId", "establishmentId", "label", "kind", "icon", "slaSeconds", "allowNote", "position", "updatedAt")
SELECT gen_random_uuid(), e."tenantId", e."id", 'Commande', 'order', 'utensils', 300, true, 100, now()
FROM "Establishment" e;

-- Les lignes de commande sont figées : ni modification ni suppression.
CREATE TRIGGER "ServiceRequestItem_append_only"
  BEFORE UPDATE OR DELETE ON "ServiceRequestItem"
  FOR EACH ROW EXECUTE FUNCTION tabilo_forbid_mutation();
