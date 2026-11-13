-- Spec 007 : étape « Prête » d'une commande, activée par établissement (cuisine séparée).
ALTER TYPE "RequestStatus" ADD VALUE IF NOT EXISTS 'ready' AFTER 'in_progress';

ALTER TABLE "Establishment" ADD COLUMN "separateKitchen" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ServiceRequest" ADD COLUMN "readyAt" TIMESTAMPTZ(3);
