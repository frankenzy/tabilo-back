/**
 * Données de TEST — jamais en production.
 *
 * Crée trois enseignes à partir de `mock.json` (racine du dépôt), chacune avec son compte entreprise,
 * son établissement, ses tables et QR codes, ses types de demande, sa carte et son équipe :
 * un propriétaire, un gérant, deux serveurs.
 *
 *   - Maquis INTERNAT : boissons uniquement (eaux comprises).
 *   - LE WEST : plats et boissons.
 *   - Texas Grillz : plats, avec les eaux et les sucreries.
 *
 * À lancer sur une base vide (après `prisma migrate reset`) :
 *
 *   SEED_PASSWORD='un-mot-de-passe-solide' pnpm seed:test
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_ROLES } from '../src/commons/constants/permissions';

const prisma = new PrismaClient();

// ------------------------------------------------------------------ catalogue (mock.json)

interface MockItem {
  nom: string;
  categorie: string;
  type?: 'alcoolisee' | 'non_alcoolisee';
}

/** `mock.json` contient deux objets JSON à la suite (`boissons`, puis `plats`) : on les lit l'un après l'autre. */
function readMock(): { boissons: MockItem[]; plats: MockItem[] } {
  const path = [join(__dirname, '..', '..', 'mock.json'), join(__dirname, 'mock.json')].find((candidate) => existsSync(candidate));
  if (!path) throw new Error('mock.json introuvable (attendu à la racine du dépôt).');
  const text = readFileSync(path, 'utf8');
  const result: { boissons: MockItem[]; plats: MockItem[] } = { boissons: [], plats: [] };
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) Object.assign(result, JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (result.boissons.length === 0 || result.plats.length === 0) throw new Error('mock.json : listes « boissons » et « plats » attendues.');
  return result;
}

/** Rubriques : libellé affiché, pictogramme (liste fermée de la spec 003) et prix par défaut en F CFA. */
const CATEGORIES: Record<string, { name: string; icon: string; price: number }> = {
  // plats
  plat_local: { name: 'Plats locaux', icon: 'utensils', price: 2500 },
  poisson: { name: 'Poissons', icon: 'fish', price: 4000 },
  volaille: { name: 'Volailles', icon: 'drumstick', price: 3500 },
  grillade: { name: 'Grillades', icon: 'beef', price: 1500 },
  viande: { name: 'Viandes', icon: 'beef', price: 4000 },
  riz: { name: 'Riz', icon: 'salad', price: 2000 },
  sauce: { name: 'Sauces', icon: 'soup', price: 2000 },
  accompagnement: { name: 'Accompagnements', icon: 'banana', price: 500 },
  // boissons
  eau: { name: 'Eaux', icon: 'glass-water', price: 500 },
  sucrerie: { name: 'Sucreries', icon: 'cup-soda', price: 500 },
  malt: { name: 'Malts', icon: 'cup-soda', price: 700 },
  jus_naturel: { name: 'Jus naturels', icon: 'citrus', price: 500 },
  energisante: { name: 'Énergisantes', icon: 'cup-soda', price: 1000 },
  biere: { name: 'Bières', icon: 'beer', price: 1000 },
  vin: { name: 'Vins', icon: 'wine', price: 2000 },
  spiritueux: { name: 'Spiritueux', icon: 'martini', price: 2000 },
  boisson_traditionnelle: { name: 'Boissons traditionnelles', icon: 'grape', price: 500 },
  boisson_chaude: { name: 'Boissons chaudes', icon: 'coffee', price: 500 },
};

/** Prix particuliers (F CFA), là où le prix de la rubrique ne convient pas. */
const PRICES: Record<string, number> = {
  Garba: 1000,
  'Alloco poisson': 2000,
  'Alloco oeuf': 1000,
  'Agouti en sauce': 6000,
  'Kedjenou de pintade': 5000,
  'Carpe braisee': 5000,
  'Machoiron braise': 5000,
  'Brochettes de boeuf': 1500,
  'Brochettes de mouton': 2000,
  'Eau gazeuse': 700,
  'Jus de coco': 1000,
  'Cocktail de fruits': 1000,
  Guinness: 1500,
  Heineken: 1500,
  Desperados: 1500,
  Budweiser: 1500,
  Champagne: 25000,
  Whisky: 3000,
};

/** Photos libres de droits déjà fournies (prisma/demo-images, voir CREDITS.md). */
const PHOTOS: Record<string, string> = {
  Garba: 'garba',
  'Attieke poisson braise': 'attieke-poisson',
  'Kedjenou de poulet': 'kedjenou',
  Alloco: 'alloco-poulet',
  'Jus de bissap': 'bissap',
  'Jus de gingembre (Gnamakoudji)': 'gnamakoudji',
  'Eau minérale': 'eau',
  Flag: 'biere',
};

// ------------------------------------------------------------------ enseignes

interface Brand {
  name: string;
  domain: string;
  address: string;
  /** Rubriques de la carte, dans l'ordre d'affichage. */
  categories: string[];
  layout: [string, string[]][];
  team: { key: string; firstName: string; lastName: string; role: 'owner' | 'manager' | 'waiter' }[];
}

const DRINKS = ['eau', 'sucrerie', 'malt', 'jus_naturel', 'energisante', 'biere', 'vin', 'spiritueux', 'boisson_traditionnelle', 'boisson_chaude'];
const FOOD = ['plat_local', 'poisson', 'volaille', 'grillade', 'viande', 'riz', 'sauce', 'accompagnement'];

const BRANDS: Brand[] = [
  {
    name: 'Maquis INTERNAT',
    domain: 'internat.tabilo.local',
    address: 'Cocody, Abidjan',
    categories: DRINKS,
    layout: [
      ['Terrasse', ['1', '2', '3', '4', '5', '6', '7', '8']],
      ['Comptoir', ['C1', 'C2', 'C3', 'C4']],
    ],
    team: [
      { key: 'proprietaire', firstName: 'Ibrahim', lastName: 'Ouattara', role: 'owner' },
      { key: 'gerant', firstName: 'Adjoua', lastName: 'Kouassi', role: 'manager' },
      { key: 'serveur1', firstName: 'Moussa', lastName: 'Traoré', role: 'waiter' },
      { key: 'serveur2', firstName: 'Aya', lastName: 'Koffi', role: 'waiter' },
    ],
  },
  {
    name: 'LE WEST',
    domain: 'lewest.tabilo.local',
    address: 'Marcory Zone 4, Abidjan',
    categories: [...FOOD, ...DRINKS],
    layout: [
      ['Salle', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']],
      ['Terrasse', ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']],
      ['Étage', ['E1', 'E2', 'E3', 'E4']],
    ],
    team: [
      { key: 'proprietaire', firstName: 'Jean-Marc', lastName: 'Kouadio', role: 'owner' },
      { key: 'gerant', firstName: 'Fatoumata', lastName: 'Cissé', role: 'manager' },
      { key: 'serveur1', firstName: 'Didier', lastName: "N'Guessan", role: 'waiter' },
      { key: 'serveur2', firstName: 'Mariam', lastName: 'Sangaré', role: 'waiter' },
    ],
  },
  {
    name: 'Texas Grillz',
    domain: 'texasgrillz.tabilo.local',
    address: 'Riviera 2, Abidjan',
    categories: [...FOOD, 'eau', 'sucrerie'],
    layout: [
      ['Salle', ['1', '2', '3', '4', '5', '6', '7', '8']],
      ['Terrasse', ['T1', 'T2', 'T3', 'T4']],
    ],
    team: [
      { key: 'proprietaire', firstName: 'Serge', lastName: 'Gnagne', role: 'owner' },
      { key: 'gerant', firstName: 'Nadia', lastName: 'Bamba', role: 'manager' },
      { key: 'serveur1', firstName: 'Yao', lastName: 'Konan', role: 'waiter' },
      { key: 'serveur2', firstName: 'Awa', lastName: 'Diomandé', role: 'waiter' },
    ],
  },
];

const REQUEST_TYPES = [
  { label: 'Appeler un serveur', icon: 'bell', slaSeconds: 180, priority: 'normal' as const },
  { label: "De l'eau", icon: 'droplet', slaSeconds: 180, priority: 'normal' as const },
  { label: "L'addition", icon: 'receipt', slaSeconds: 240, priority: 'normal' as const },
  { label: 'Assistance', icon: 'life-buoy', slaSeconds: 120, priority: 'high' as const },
  { label: 'Autre demande', icon: 'message-circle', slaSeconds: 240, priority: 'normal' as const },
];

const SEATS = [2, 4, 4, 4, 6, 8];

// ------------------------------------------------------------------ création

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Le jeu de test est interdit en production.');
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 10) throw new Error('Définissez SEED_PASSWORD (10 caractères au minimum).');
  if ((await prisma.tenant.count()) > 0) throw new Error('La base n’est pas vide : lancez d’abord « pnpm exec prisma migrate reset ».');

  const mock = readMock();
  const catalogue = [...mock.plats, ...mock.boissons];
  const unknown = catalogue.filter((item) => !CATEGORIES[item.categorie]);
  if (unknown.length > 0) throw new Error(`Rubriques inconnues : ${[...new Set(unknown.map((item) => item.categorie))].join(', ')}`);

  // Rôles système (mêmes définitions que l'application).
  for (const definition of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({ where: { tenantId: null, key: definition.key } });
    const data = { name: definition.name, permissions: definition.permissions, isSystem: true };
    if (existing) await prisma.role.update({ where: { id: existing.id }, data });
    else await prisma.role.create({ data: { ...data, key: definition.key } });
  }
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { tenantId: null } })).map((role) => [role.key, role.id]));
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const photosDir = join(__dirname, 'demo-images');

  for (const brand of BRANDS) {
    const tenant = await prisma.tenant.create({ data: { name: brand.name } });
    const establishment = await prisma.establishment.create({
      data: { tenantId: tenant.id, name: brand.name, timezone: 'Africa/Abidjan', address: brand.address },
    });
    const scoped = { tenantId: tenant.id, establishmentId: establishment.id };

    for (const person of brand.team) {
      const user = await prisma.user.create({
        data: { tenantId: tenant.id, email: `${person.key}@${brand.domain}`, firstName: person.firstName, lastName: person.lastName, passwordHash },
      });
      await prisma.membership.create({ data: { ...scoped, userId: user.id, roleId: roles[person.role] } });
    }

    for (const [position, def] of REQUEST_TYPES.entries()) {
      await prisma.requestType.create({ data: { ...scoped, ...def, position } });
    }
    // Type « Commande » : un seul par établissement, utilisé par la carte (spec 001, R5).
    await prisma.requestType.create({ data: { ...scoped, label: 'Commande', kind: 'order', icon: 'utensils', slaSeconds: 300, position: 100 } });

    await prisma.escalationRule.createMany({
      data: [
        { ...scoped, name: 'Non prise en charge après 5 min', trigger: 'not_accepted', afterSeconds: 300 },
        { ...scoped, name: 'Non résolue après 15 min', trigger: 'not_resolved', afterSeconds: 900 },
      ],
    });

    // Carte : une rubrique par catégorie du mock retenue pour l'enseigne.
    let items = 0;
    for (const [position, key] of brand.categories.entries()) {
      const def = CATEGORIES[key];
      const category = await prisma.menuCategory.create({ data: { ...scoped, name: def.name, icon: def.icon, position } });
      const entries = catalogue.filter((item) => item.categorie === key);
      for (const [itemPosition, entry] of entries.entries()) {
        const slug = PHOTOS[entry.nom];
        const imageId = slug
          ? (await prisma.menuImage.create({ data: { ...scoped, mime: 'image/jpeg', data: readFileSync(join(photosDir, `${slug}.jpg`)) } })).id
          : null;
        await prisma.menuItem.create({
          data: {
            ...scoped,
            categoryId: category.id,
            name: entry.nom,
            description: entry.type === 'alcoolisee' ? 'Boisson alcoolisée' : null,
            priceMinor: PRICES[entry.nom] ?? def.price,
            position: itemPosition,
            imageId,
          },
        });
        items += 1;
      }
    }

    let tableCount = 0;
    for (const [position, [areaName, labels]] of brand.layout.entries()) {
      const area = await prisma.diningArea.create({ data: { ...scoped, name: areaName, position } });
      for (const [index, label] of labels.entries()) {
        const table = await prisma.diningTable.create({ data: { ...scoped, areaId: area.id, label, seats: SEATS[index % SEATS.length] } });
        await prisma.qrCode.create({ data: { ...scoped, tableId: table.id, code: randomBytes(18).toString('base64url') } });
        tableCount += 1;
      }
    }

    console.log(`${brand.name} : ${brand.categories.length} rubriques, ${items} articles, ${tableCount} tables.`);
    for (const person of brand.team) console.log(`  ${person.role.padEnd(8)} ${person.firstName} ${person.lastName} — ${person.key}@${brand.domain}`);
  }
  console.log('Mot de passe de tous les comptes : celui de SEED_PASSWORD.');
}

main()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
