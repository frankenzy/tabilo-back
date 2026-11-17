-- Spec 026 : règlement des commandes servies.
ALTER TABLE "ServiceRequest" ADD COLUMN "paidAt" TIMESTAMPTZ(3);

-- R10 : les commandes servies avant cette évolution sont considérées comme réglées à leur heure de service.
UPDATE "ServiceRequest" SET "paidAt" = "resolvedAt"
WHERE status = 'resolved' AND "totalMinor" IS NOT NULL AND "resolvedAt" IS NOT NULL;

