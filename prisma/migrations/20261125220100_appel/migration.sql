-- Spec 029, R1 : une demande « Appel » et une demande « Message » par établissement, reconnues par leur genre.

-- 1. « Appeler un serveur » (pictogramme cloche) devient l'appel.
UPDATE "RequestType" t
SET kind = 'call', "perSession" = false, "allowNote" = false, "updatedAt" = now()
FROM (
  SELECT DISTINCT ON ("establishmentId") id
  FROM "RequestType"
  WHERE kind = 'service' AND icon = 'bell' AND "archivedAt" IS NULL
  ORDER BY "establishmentId", position, "createdAt"
) c
WHERE t.id = c.id;

-- 2. « Autre demande » (pictogramme bulle) devient le message : texte autorisé, propre au client.
UPDATE "RequestType" t
SET kind = 'message', "perSession" = true, "allowNote" = true, "updatedAt" = now()
FROM (
  SELECT DISTINCT ON ("establishmentId") id
  FROM "RequestType"
  WHERE kind = 'service' AND icon = 'message-circle' AND "archivedAt" IS NULL
  ORDER BY "establishmentId", position, "createdAt"
) m
WHERE t.id = m.id;

-- 3. Un établissement qui n'en avait pas les reçoit, actives : le bouton « Serveur » n'offre plus qu'elles.
INSERT INTO "RequestType" (id, "tenantId", "establishmentId", label, kind, icon, priority, "slaSeconds", "allowNote", "perSession", "isActive", position, "createdAt", "updatedAt")
SELECT gen_random_uuid(), e."tenantId", e.id, 'Appeler un serveur', 'call', 'bell', 'normal', 180, false, false, true, 0, now(), now()
FROM "Establishment" e
WHERE NOT EXISTS (SELECT 1 FROM "RequestType" t WHERE t."establishmentId" = e.id AND t.kind = 'call' AND t."archivedAt" IS NULL);

INSERT INTO "RequestType" (id, "tenantId", "establishmentId", label, kind, icon, priority, "slaSeconds", "allowNote", "perSession", "isActive", position, "createdAt", "updatedAt")
SELECT gen_random_uuid(), e."tenantId", e.id, 'Message', 'message', 'message-circle', 'normal', 240, true, true, true, 4, now(), now()
FROM "Establishment" e
WHERE NOT EXISTS (SELECT 1 FROM "RequestType" t WHERE t."establishmentId" = e.id AND t.kind = 'message' AND t."archivedAt" IS NULL);

-- 4. Jamais deux appels ni deux messages actifs dans un établissement.
CREATE UNIQUE INDEX "RequestType_one_call_per_establishment"
  ON "RequestType" ("establishmentId") WHERE kind = 'call' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "RequestType_one_message_per_establishment"
  ON "RequestType" ("establishmentId") WHERE kind = 'message' AND "archivedAt" IS NULL;
