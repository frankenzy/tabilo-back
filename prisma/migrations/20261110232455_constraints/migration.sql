-- Contraintes que le schéma Prisma ne sait pas exprimer.

-- Unicité limitée aux éléments actifs : un libellé archivé peut être réutilisé.
CREATE UNIQUE INDEX "DiningTable_active_label_key"
  ON "DiningTable" ("establishmentId", lower("label")) WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "DiningArea_active_name_key"
  ON "DiningArea" ("establishmentId", lower("name")) WHERE "archivedAt" IS NULL;

-- Un seul QR actif par table.
CREATE UNIQUE INDEX "QrCode_one_active_per_table_key"
  ON "QrCode" ("tableId") WHERE "status" = 'active';

-- Rôles système (tenantId NULL) : clé unique malgré le NULL.
CREATE UNIQUE INDEX "Role_system_key_key" ON "Role" ("key") WHERE "tenantId" IS NULL;

-- Cohérence des demandes.
ALTER TABLE "ServiceRequest"
  ADD CONSTRAINT "ServiceRequest_assignee_matches_status" CHECK (
    ("status" = 'pending' AND "assigneeId" IS NULL)
    OR ("status" IN ('assigned', 'accepted', 'in_progress') AND "assigneeId" IS NOT NULL)
    OR "status" IN ('resolved', 'cancelled')
  ),
  ADD CONSTRAINT "ServiceRequest_note_length" CHECK ("note" IS NULL OR char_length("note") <= 280);

-- Journaux append-only : toute modification ou suppression est refusée par la base elle-même.
CREATE FUNCTION tabilo_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La table % est append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServiceRequestEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ServiceRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION tabilo_forbid_mutation();

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION tabilo_forbid_mutation();
