-- Spec 028 : « L'addition » devient un genre de demande à part.
-- Migration séparée : une valeur ajoutée à un type énuméré n'est utilisable qu'après validation de la transaction.
ALTER TYPE "RequestTypeKind" ADD VALUE IF NOT EXISTS 'bill';
