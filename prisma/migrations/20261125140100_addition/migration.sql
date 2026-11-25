-- Spec 028, R1 : une demande « L'addition » par établissement, reconnue par son genre et non plus par son pictogramme.

-- 1. La demande « L'addition » existante (pictogramme reçu) devient la demande d'addition : une seule par établissement.
UPDATE "RequestType" t
SET kind = 'bill', "perSession" = true, "updatedAt" = now()
FROM (
  SELECT DISTINCT ON ("establishmentId") id
  FROM "RequestType"
  WHERE kind = 'service' AND icon = 'receipt' AND "archivedAt" IS NULL
  ORDER BY "establishmentId", position, "createdAt"
) b
WHERE t.id = b.id;

-- 2. Un établissement qui n'en avait pas la reçoit, désactivée pour ne rien changer à ce que voient ses clients.
INSERT INTO "RequestType" (id, "tenantId", "establishmentId", label, kind, icon, priority, "slaSeconds", "allowNote", "perSession", "isActive", position, "createdAt", "updatedAt")
SELECT gen_random_uuid(), e."tenantId", e.id, 'L''addition', 'bill', 'receipt', 'normal', 240, false, true, false, 2, now(), now()
FROM "Establishment" e
WHERE NOT EXISTS (
  SELECT 1 FROM "RequestType" t WHERE t."establishmentId" = e.id AND t.kind = 'bill' AND t."archivedAt" IS NULL
);

-- 3. Jamais deux demandes d'addition actives dans un établissement.
CREATE UNIQUE INDEX "RequestType_one_bill_per_establishment"
  ON "RequestType" ("establishmentId") WHERE kind = 'bill' AND "archivedAt" IS NULL;

