#!/bin/sh
# Démarrage de l'API avec migrations (Render, offre gratuite : pas d'étape « pre-deploy »).
# `prisma migrate deploy` est sans effet si la base est à jour ; `exec` laisse Node recevoir les signaux d'arrêt.
# Neon en veille, ou l'ancienne instance qui s'arrête pendant le redéploiement, peut faire échouer une première
# tentative (P1001, P1002 : verrou de migration non obtenu à temps) : on réessaie avant d'abandonner.
set -e
attempt=1
until ./node_modules/.bin/prisma migrate deploy; do
  if [ "$attempt" -ge 5 ]; then
    echo "Migrations impossibles après $attempt tentatives." >&2
    exit 1
  fi
  echo "Migrations : tentative $attempt échouée, nouvel essai dans $((attempt * 5)) s." >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done
exec node dist/main.js
