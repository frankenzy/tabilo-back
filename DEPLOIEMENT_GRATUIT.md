# Déploiement gratuit (démonstrations)

Pour montrer TABILO à des prospects sans louer de serveur. Pour la production, voir `DEPLOYMENT_GUIDE.md`.

Deux dépôts : `tabilo-web` (frontend) et `tabilo-back` (API).

| Brique | Service | Offre |
|---|---|---|
| Frontend Next.js | Vercel | Hobby |
| API NestJS (+ worker) | Render | Free (Docker) |
| PostgreSQL | Neon | Free |
| Redis | Redis Cloud | Free 30 Mo |
| Réveil de l'API | cron-job.org | Gratuit |

Les quotas gratuits évoluent : vérifier les conditions de chaque service à l'inscription.

## Principe

```
navigateur ──► https://<projet>.vercel.app          (pages)
           ──► https://<projet>.vercel.app/api/*    ──relayé──►  https://tabilo-api.onrender.com/api/*
           ──► wss://tabilo-api.onrender.com        (Socket.IO, en direct)
```

Les appels `/api` passent par Vercel : la page et l'API sont alors sur le même site et le cookie de
rafraîchissement (`SameSite=Strict`) est bien envoyé. Vercel ne relaie pas les WebSockets : le temps réel
va directement sur Render, authentifié par jeton (aucun cookie).

## 1. Base PostgreSQL — Neon

1. Créer un projet, région **AWS Europe Central (Frankfurt)** (même région que Render).
2. Copier la chaîne de connexion **directe** (décocher « Connection pooling » : l'hôte ne contient pas `-pooler`).
   Ajouter `&schema=public` si absent. Exemple :
   `postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require&schema=public`

## 2. Redis — Redis Cloud

1. Créer une base gratuite (30 Mo), région Europe.
2. Politique d'éviction : **noeviction** (BullMQ l'exige).
3. Noter l'URL : `redis://default:<mot-de-passe>@<hôte>:<port>` (`rediss://` si TLS activé ; les deux fonctionnent).

## 3. API — Render

1. Pousser l'API sur `main` du dépôt `tabilo-back`.
2. Render → **New → Blueprint** → choisir `tabilo-back` : `render.yaml` (à la racine du dépôt) est lu.
3. Saisir les variables demandées :
   - `DATABASE_URL` : chaîne Neon de l'étape 1 ;
   - `REDIS_URL` : URL de l'étape 2 ;
   - `CORS_ORIGINS` et `PUBLIC_WEB_URL` : `https://<projet>.vercel.app` (adresse connue à l'étape 4 ;
     mettre une valeur provisoire puis corriger).
4. Attendre le premier déploiement, puis vérifier `https://tabilo-api.onrender.com/api/v1/health/ready`.

Les migrations Prisma passent à chaque démarrage (`prisma migrate deploy`, sans effet si la base est à jour).

## 4. Frontend — Vercel

1. **Add New → Project** → dépôt `tabilo-web`, racine du dépôt (pnpm est détecté).
2. Variables d'environnement (Production) :
   - `NEXT_PUBLIC_API_URL` = `https://<projet>.vercel.app` (l'adresse du frontend lui-même) ;
   - `API_PROXY_TARGET` = `https://tabilo-api.onrender.com` ;
   - `NEXT_PUBLIC_REALTIME_URL` = `https://tabilo-api.onrender.com`.
3. Déployer. Si l'adresse finale diffère de celle mise en variable, la corriger ici **et** dans
   `CORS_ORIGINS` / `PUBLIC_WEB_URL` sur Render, puis redéployer les deux (les `NEXT_PUBLIC_*` sont figées au build).

Les déploiements « Preview » de Vercel (autres adresses) ne sont pas dans `CORS_ORIGINS` : utiliser l'adresse de production.

## 5. Garder l'API éveillée — cron-job.org

L'offre gratuite de Render endort le service après 15 min sans requête (réveil ≈ 1 min), ce qui coupe aussi
le worker (escalades, expirations de sessions). Créer une tâche :
- URL : `https://tabilo-api.onrender.com/api/v1/health/live`
- Fréquence : toutes les 10 minutes.

Les 750 h mensuelles de Render couvrent un service allumé en continu.

## 6. Données de démonstration

Depuis le poste, avec la chaîne Neon :

```bash
cd backend
DATABASE_URL='<chaîne Neon>' npm run seed:demo
DATABASE_URL='<chaîne Neon>' npm run seed:demo-photos
```

## Limites connues

- Premier appel lent si le réveil a échoué ; ouvrir l'application quelques minutes avant un rendez-vous.
- Neon free : 0,5 Go ; Redis Cloud free : 30 Mo ; suffisant pour quelques établissements de démonstration.
- Vercel Hobby est réservé à un usage non commercial : passer à une offre payante ou au déploiement
  Docker (`DEPLOYMENT_GUIDE.md`) dès les premiers clients.
