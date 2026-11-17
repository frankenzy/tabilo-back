-- Index partiels pour les ventes et le règlement (le schéma Prisma ne sait pas les exprimer).
-- Mesuré sur un an d'activité simulée (91 000 demandes) : « Total vendu » du mois passe de 166 à 18 ms.

-- Commandes servies, datées du service : ventes (spec 009), passages à table.
CREATE INDEX "ServiceRequest_served_idx" ON "ServiceRequest" ("establishmentId", "resolvedAt")
  INCLUDE ("tenantId", "tableId", "createdAt", "totalMinor")
  WHERE "status" = 'resolved' AND "totalMinor" IS NOT NULL;
-- Commandes réglées, datées du règlement : total encaissé (spec 026, R7).
CREATE INDEX "ServiceRequest_paid_idx" ON "ServiceRequest" ("establishmentId", "paidAt")
  INCLUDE ("tenantId", "totalMinor")
  WHERE "paidAt" IS NOT NULL AND "totalMinor" IS NOT NULL;
-- Commandes servies non réglées : reste à encaisser, liste « À régler », montant d'une table (spec 026).
CREATE INDEX "ServiceRequest_unpaid_idx" ON "ServiceRequest" ("establishmentId", "createdAt")
  INCLUDE ("tenantId", "tableId", "totalMinor")
  WHERE "status" = 'resolved' AND "paidAt" IS NULL AND "totalMinor" IS NOT NULL;
