-- Spec 003 : chaque rubrique a un pictogramme et, au choix, une photo (carte lisible sans savoir lire).
ALTER TABLE "MenuCategory" ADD COLUMN "icon" TEXT NOT NULL DEFAULT 'utensils';
ALTER TABLE "MenuCategory" ADD COLUMN "imageId" UUID;

CREATE UNIQUE INDEX "MenuCategory_imageId_key" ON "MenuCategory"("imageId");

ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_imageId_fkey"
  FOREIGN KEY ("imageId") REFERENCES "MenuImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reprise : pictogramme deviné d'après le nom des rubriques existantes (R2).
UPDATE "MenuCategory" SET "icon" = 'cup-soda'  WHERE "name" ~* '(boisson|jus|soda|drink)';
UPDATE "MenuCategory" SET "icon" = 'ice-cream' WHERE "name" ~* '(dessert|glace|sucr)';
UPDATE "MenuCategory" SET "icon" = 'apple'     WHERE "name" ~* 'fruit';
UPDATE "MenuCategory" SET "icon" = 'coffee'    WHERE "name" ~* '(café|cafe|thé|the chaud|boissons chaudes)';
UPDATE "MenuCategory" SET "icon" = 'beer'      WHERE "name" ~* '(bière|biere|alcool)';
