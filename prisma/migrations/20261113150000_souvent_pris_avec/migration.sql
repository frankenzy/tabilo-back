-- Spec 012, R7 : la rangée « Souvent pris avec » de la fiche d'un plat se règle par établissement, désactivée par défaut.
ALTER TABLE "Establishment" ADD COLUMN "pairingsEnabled" BOOLEAN NOT NULL DEFAULT false;
