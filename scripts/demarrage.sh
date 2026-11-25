#!/bin/sh
# Démarrage de l'API avec migrations (Render, offre gratuite : pas d'étape « pre-deploy »).
# `prisma migrate deploy` est sans effet si la base est à jour ; `exec` laisse Node recevoir les signaux d'arrêt.
set -e
./node_modules/.bin/prisma migrate deploy
exec node dist/main.js
