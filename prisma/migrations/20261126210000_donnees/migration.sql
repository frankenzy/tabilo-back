-- Spec 041 : acceptation des conditions, export, fermeture et effacement d'un compte.
ALTER TABLE "Tenant"
  ADD COLUMN "termsVersion" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastExportAt" TIMESTAMPTZ(3),
  ADD COLUMN "closedAt" TIMESTAMPTZ(3),
  ADD COLUMN "closeReason" TEXT,
  ADD COLUMN "deleteAfter" TIMESTAMPTZ(3),
  ADD COLUMN "erasedAt" TIMESTAMPTZ(3);
