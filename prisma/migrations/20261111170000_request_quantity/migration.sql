-- Spec 005 : quantité d'une demande de service (ex. 2 bouteilles d'eau).
ALTER TABLE "ServiceRequest" ADD COLUMN "quantity" INTEGER;
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_quantity_range" CHECK ("quantity" IS NULL OR "quantity" BETWEEN 1 AND 10);
