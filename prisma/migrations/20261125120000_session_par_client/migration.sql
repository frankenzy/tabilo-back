-- Spec 027 : une session par client (repère, règlement par session, zone, alerte de départ sans payer).

-- CreateEnum
CREATE TYPE "ZoneCheck" AS ENUM ('inside', 'outside', 'imprecise', 'denied');

-- CreateEnum
CREATE TYPE "UnpaidAlertReason" AS ENUM ('inactivity', 'released', 'expired');

-- CreateEnum
CREATE TYPE "UnpaidAlertResolution" AS ENUM ('paid', 'still_here', 'walked_out');

-- AlterEnum
ALTER TYPE "SessionStatus" ADD VALUE 'settled';

-- AlterTable
ALTER TABLE "Establishment" ADD COLUMN     "unpaidAlertMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "zoneLatitude" DOUBLE PRECISION,
ADD COLUMN     "zoneLongitude" DOUBLE PRECISION,
ADD COLUMN     "zoneRadiusM" INTEGER NOT NULL DEFAULT 150;

-- AlterTable
ALTER TABLE "TableSession" ADD COLUMN     "alertSnoozedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "lastActivityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "markerIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RequestType" ADD COLUMN     "perSession" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "writtenOffAt" TIMESTAMPTZ(3),
ADD COLUMN     "writtenOffById" UUID,
ADD COLUMN     "zoneCheck" "ZoneCheck",
ADD COLUMN     "zoneDistanceM" INTEGER;

-- CreateTable
CREATE TABLE "UnpaidAlert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "establishmentId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" "UnpaidAlertReason" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" "UnpaidAlertResolution",
    "resolvedById" UUID,

    CONSTRAINT "UnpaidAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnpaidAlert_establishmentId_resolvedAt_idx" ON "UnpaidAlert"("establishmentId", "resolvedAt");

-- CreateIndex
CREATE INDEX "UnpaidAlert_sessionId_idx" ON "UnpaidAlert"("sessionId");

-- AddForeignKey
ALTER TABLE "UnpaidAlert" ADD CONSTRAINT "UnpaidAlert_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "Establishment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnpaidAlert" ADD CONSTRAINT "UnpaidAlert_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TableSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- R2 : deux sessions ouvertes d'une même table n'ont jamais le même repère, même en cas de scans simultanés.
CREATE UNIQUE INDEX "TableSession_open_marker_key" ON "TableSession"("tableId", "markerIndex") WHERE status = 'open';

-- R9 : une seule alerte ouverte par session.
CREATE UNIQUE INDEX "UnpaidAlert_open_session_key" ON "UnpaidAlert"("sessionId") WHERE "resolvedAt" IS NULL;

-- R9 : l'alerte cherche les sessions inactives.
CREATE INDEX "TableSession_establishmentId_status_lastActivityAt_idx" ON "TableSession"("establishmentId", status, "lastActivityAt");

-- Reprise : activité connue des sessions existantes.
UPDATE "TableSession" SET "lastActivityAt" = COALESCE("lastRequestAt", "openedAt");

-- Reprise : repères des sessions ouvertes, dans l'ordre d'ouverture, par table.
UPDATE "TableSession" s SET "markerIndex" = r.n
FROM (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY "tableId" ORDER BY "openedAt", id) - 1)::int AS n
  FROM "TableSession" WHERE status = 'open'
) r
WHERE s.id = r.id;

-- R6 : « L'addition » (type par défaut, icône receipt) se demande par session.
UPDATE "RequestType" SET "perSession" = true WHERE kind = 'service' AND icon = 'receipt';
