-- Spec 029, R1 : genres « Appel » et « Message », seuls dans leur migration (une valeur ajoutée ne s'utilise pas dans la même transaction).
ALTER TYPE "RequestTypeKind" ADD VALUE IF NOT EXISTS 'call';
ALTER TYPE "RequestTypeKind" ADD VALUE IF NOT EXISTS 'message';
