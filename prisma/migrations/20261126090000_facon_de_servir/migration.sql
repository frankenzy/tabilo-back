-- Spec 030 : façon de servir réglable par établissement.
CREATE TYPE "ServiceMode" AS ENUM ('serve_then_pay', 'pay_anytime', 'pay_first');

-- R6 : commande à encaisser avant la préparation.
ALTER TYPE "RequestStatus" ADD VALUE IF NOT EXISTS 'awaiting_payment' BEFORE 'pending';

-- R1 et R9 : les établissements existants gardent le fonctionnement actuel.
ALTER TABLE "Establishment"
  ADD COLUMN "serviceMode" "ServiceMode" NOT NULL DEFAULT 'serve_then_pay',
  ADD COLUMN "autoStartOrders" BOOLEAN NOT NULL DEFAULT false;

-- R2 : façon de servir figée sur la commande.
ALTER TABLE "ServiceRequest" ADD COLUMN "serviceMode" "ServiceMode";
