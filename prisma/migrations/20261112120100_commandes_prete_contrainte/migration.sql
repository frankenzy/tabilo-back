-- Spec 007 : une commande « prête » garde son préparateur. Migration séparée :
-- PostgreSQL n'autorise pas une valeur d'enum dans la transaction qui l'ajoute.
ALTER TABLE "ServiceRequest" DROP CONSTRAINT "ServiceRequest_assignee_matches_status";
ALTER TABLE "ServiceRequest"
  ADD CONSTRAINT "ServiceRequest_assignee_matches_status" CHECK (
    ("status" = 'pending' AND "assigneeId" IS NULL)
    OR ("status" IN ('assigned', 'accepted', 'in_progress', 'ready') AND "assigneeId" IS NOT NULL)
    OR "status" IN ('resolved', 'cancelled')
  );
