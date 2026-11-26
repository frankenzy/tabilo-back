-- Spec 030 : une commande « à encaisser » n'a personne d'affecté ; une commande partie en préparation
-- sans personne affectée (encaissée, ou lancée tout de suite, R7 et R9) doit avoir été acceptée.
-- Migration distincte de `facon_de_servir` : PostgreSQL n'utilise pas une valeur d'enum ajoutée dans la même transaction.
ALTER TABLE "ServiceRequest" DROP CONSTRAINT "ServiceRequest_assignee_matches_status";
ALTER TABLE "ServiceRequest"
  ADD CONSTRAINT "ServiceRequest_assignee_matches_status" CHECK (
    ("status" IN ('pending', 'awaiting_payment') AND "assigneeId" IS NULL)
    OR ("status" IN ('assigned', 'accepted') AND "assigneeId" IS NOT NULL)
    OR ("status" IN ('in_progress', 'ready') AND ("assigneeId" IS NOT NULL OR "acceptedAt" IS NOT NULL))
    OR "status" IN ('resolved', 'cancelled')
  );
