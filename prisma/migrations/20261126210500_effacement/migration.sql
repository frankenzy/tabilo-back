-- Spec 041, R4 et R6 : l'effacement d'un compte et la purge des données personnelles sont la seule exception
-- aux tables append-only. Elle n'est ouverte que dans une transaction qui pose `tabilo.allow_erasure = on`
-- (SET LOCAL / set_config(..., true)) : seules les tâches d'effacement et de purge le font.
CREATE OR REPLACE FUNCTION tabilo_forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('tabilo.allow_erasure', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'La table % est append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
