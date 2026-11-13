-- Spec 010 : permissions retirées à un employé, parmi celles de son rôle (jamais au-delà).
ALTER TABLE "Membership" ADD COLUMN "revokedPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
