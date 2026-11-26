-- Spec 031 : apparence de l'établissement (logo, couleur, mot d'accueil).
ALTER TABLE "Establishment"
  ADD COLUMN "logoImageId" UUID,
  ADD COLUMN "brandColor" TEXT NOT NULL DEFAULT 'orange',
  ADD COLUMN "welcomeText" TEXT;

CREATE UNIQUE INDEX "Establishment_logoImageId_key" ON "Establishment"("logoImageId");

ALTER TABLE "Establishment" ADD CONSTRAINT "Establishment_logoImageId_fkey"
  FOREIGN KEY ("logoImageId") REFERENCES "MenuImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
