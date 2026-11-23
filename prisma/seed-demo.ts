/**
 * Données de DÉMONSTRATION — jamais en production.
 *
 * Crée un tenant « Démo TABILO » avec un établissement, une équipe, des tables, une carte et une
 * semaine de demandes et de commandes fictives, pour découvrir l'interface. Tout y est identifié comme démonstration.
 *
 *   DEMO_PASSWORD='un-mot-de-passe-solide' pnpm seed:demo
 *
 * Relancer le script remplace le précédent tenant de démonstration.
 */
import { Prisma, PrismaClient, RequestStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { SYSTEM_ROLES } from '../src/commons/constants/permissions';
import { demoPhoto } from './demo-images';

const prisma = new PrismaClient();
const DEMO_TENANT = 'Démo TABILO';
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const between = (min: number, max: number) => min + Math.random() * (max - min);

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Le jeu de démonstration est interdit en production.');
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error('Définissez DEMO_PASSWORD (10 caractères au minimum).');

  // Rôles système (mêmes définitions que l'application).
  for (const definition of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({ where: { tenantId: null, key: definition.key } });
    const data = { name: definition.name, permissions: definition.permissions, isSystem: true };
    if (existing) await prisma.role.update({ where: { id: existing.id }, data });
    else await prisma.role.create({ data: { ...data, key: definition.key } });
  }
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { tenantId: null } })).map((r) => [r.key, r.id]));

  // Remplace l'ancien tenant de démonstration. Les journaux append-only refusent toute
  // suppression : la base de démonstration se réinitialise donc en recréant un tenant neuf.
  const previous = await prisma.tenant.findFirst({ where: { name: DEMO_TENANT } });
  if (previous) {
    await prisma.user.updateMany({
      where: { tenantId: previous.id },
      data: { status: 'disabled' },
    });
    await prisma.$executeRaw`UPDATE "User" SET email = 'archive-' || id || '@demo.invalid' WHERE "tenantId" = ${previous.id}::uuid`;
    await prisma.tenant.update({ where: { id: previous.id }, data: { name: `${DEMO_TENANT} (archivé)`, status: 'suspended' } });
  }

  const tenant = await prisma.tenant.create({ data: { name: DEMO_TENANT } });
  const establishment = await prisma.establishment.create({
    data: { tenantId: tenant.id, name: 'Le Maquis (démo)', timezone: 'Africa/Abidjan', address: 'Plateau, Abidjan', requestCooldownSeconds: 5 },
  });
  const scoped = { tenantId: tenant.id, establishmentId: establishment.id };
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const people = [
    { email: 'gerant@demo.tabilo.local', firstName: 'Awa', lastName: 'Koné', role: 'owner' },
    { email: 'salle@demo.tabilo.local', firstName: 'Mariam', lastName: 'Diallo', role: 'manager' },
    { email: 'koffi@demo.tabilo.local', firstName: 'Koffi', lastName: 'Yao', role: 'waiter' },
    { email: 'fatou@demo.tabilo.local', firstName: 'Fatou', lastName: 'Bamba', role: 'waiter' },
    { email: 'serge@demo.tabilo.local', firstName: 'Serge', lastName: 'Aka', role: 'waiter' },
  ];
  const users: { id: string; role: string }[] = [];
  for (const person of people) {
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: person.email, firstName: person.firstName, lastName: person.lastName, passwordHash },
    });
    await prisma.membership.create({ data: { ...scoped, userId: user.id, roleId: roles[person.role] } });
    users.push({ id: user.id, role: person.role });
  }
  const waiters = users.filter((u) => u.role === 'waiter');

  const typeDefs = [
    { label: 'Appeler un serveur', icon: 'bell', slaSeconds: 180, priority: 'normal' as const },
    { label: "De l'eau", icon: 'droplet', slaSeconds: 180, priority: 'normal' as const },
    { label: "L'addition", icon: 'receipt', slaSeconds: 240, priority: 'normal' as const },
    { label: 'Assistance', icon: 'life-buoy', slaSeconds: 120, priority: 'high' as const },
    { label: 'Autre demande', icon: 'message-circle', slaSeconds: 240, priority: 'normal' as const },
  ];
  const types: { id: string; slaSeconds: number; priority: 'normal' | 'high' }[] = [];
  for (const [position, def] of typeDefs.entries()) {
    types.push(await prisma.requestType.create({ data: { ...scoped, ...def, position } }));
  }
  // Type « Commande » : un seul par établissement, utilisé par la carte (spec 001, R5).
  const orderType = await prisma.requestType.create({
    data: { ...scoped, label: 'Commande', kind: 'order', icon: 'utensils', slaSeconds: 300, position: 100 },
  });

  // Carte de démonstration (prix en F CFA, unité mineure = 1).
  const menuDefs: [string, string, [string, string | null, number, boolean?][]][] = [
    ['Plats', 'utensils', [
      ['Garba', 'Attiéké, thon frit, piment', 1500],
      ['Alloco poulet', 'Banane plantain frite, poulet braisé', 3000],
      ['Attiéké poisson braisé', 'Carpe braisée, attiéké, oignons', 4500],
      ['Kedjenou de poulet', 'Mijoté à l\'étouffée, riz blanc', 5000, false],
    ]],
    ['Boissons', 'cup-soda', [
      ['Bissap', 'Jus d\'hibiscus maison', 500],
      ['Gnamakoudji', 'Jus de gingembre maison', 500],
      ['Eau minérale 1,5 L', null, 1000],
      ['Bière locale 65 cl', null, 1500],
    ]],
    ['Desserts', 'ice-cream', [
      ['Dêguê', 'Mil et lait caillé', 1000],
      ['Salade de fruits', 'Fruits de saison', 1500],
    ]],
  ];
  const menu: { id: string; name: string; priceMinor: number }[] = [];
  /** Photo libre de droits (prisma/demo-images, voir CREDITS.md), si le jeu en prévoit une. */
  const photo = async (name: string) => {
    const data = demoPhoto(name);
    return data ? (await prisma.menuImage.create({ data: { ...scoped, mime: 'image/jpeg', data } })).id : null;
  };
  for (const [position, [name, icon, items]] of menuDefs.entries()) {
    const category = await prisma.menuCategory.create({ data: { ...scoped, name, icon, position, imageId: await photo(name) } });
    for (const [itemPosition, [itemName, description, priceMinor, isAvailable = true]] of items.entries()) {
      const item = await prisma.menuItem.create({
        data: { ...scoped, categoryId: category.id, name: itemName, description, priceMinor, isAvailable, position: itemPosition, imageId: await photo(itemName) },
      });
      if (isAvailable) menu.push({ id: item.id, name: itemName, priceMinor });
    }
  }
  /** Une à trois lignes tirées de la carte, quantités de 1 à 3. */
  const randomLines = () => {
    const chosen = [...menu].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
    return chosen.map((item) => ({ menuItemId: item.id, name: item.name, unitPriceMinor: item.priceMinor, quantity: 1 + Math.floor(Math.random() * 3) }));
  };

  await prisma.escalationRule.createMany({
    data: [
      { ...scoped, name: 'Non prise en charge après 5 min', trigger: 'not_accepted', afterSeconds: 300 },
      { ...scoped, name: 'Non résolue après 15 min', trigger: 'not_resolved', afterSeconds: 900 },
    ],
  });

  const layout: [string, string[]][] = [
    ['Salle', ['1', '2', '3', '4', '5', '6', '7', '8']],
    ['Terrasse', ['T1', 'T2', 'T3', 'T4', 'T5']],
    ['Étage', ['E1', 'E2', 'E3']],
  ];
  const tables: { id: string; areaId: string }[] = [];
  for (const [position, [name, labels]] of layout.entries()) {
    const area = await prisma.diningArea.create({ data: { ...scoped, name, position } });
    for (const label of labels) {
      const table = await prisma.diningTable.create({ data: { ...scoped, areaId: area.id, label, seats: pick([2, 4, 4, 6]) } });
      await prisma.qrCode.create({ data: { ...scoped, tableId: table.id, code: randomBytes(18).toString('base64url') } });
      tables.push({ id: table.id, areaId: area.id });
    }
  }

  /** Crée une demande dans l'état voulu, avec ses horodatages et ses événements cohérents. */
  async function request(
    createdAt: Date,
    status: RequestStatus,
    options: { acceptAfter?: number; table?: number; type?: number; escalated?: boolean; order?: boolean } = {},
  ) {
    const type = options.order ? orderType : types[options.type ?? Math.floor(Math.random() * types.length)];
    const lines = options.order ? randomLines() : [];
    const table = options.table !== undefined ? tables[options.table] : pick(tables);
    const waiter = pick(waiters);
    const at = (seconds: number) => new Date(createdAt.getTime() + seconds * 1000);
    const acceptAfter = options.acceptAfter ?? between(25, 330);
    const startAfter = acceptAfter + between(10, 60);
    const resolveAfter = startAfter + between(40, 420);
    const handled = status !== 'pending' && status !== 'cancelled';
    const events: Prisma.ServiceRequestEventCreateManyInput[] = [];
    const created = await prisma.serviceRequest.create({
      data: {
        ...scoped,
        tableId: table.id,
        areaId: table.areaId,
        requestTypeId: type.id,
        source: options.order || Math.random() < 0.85 ? 'customer' : 'staff',
        totalMinor: options.order ? lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0) : null,
        priority: type.priority,
        status,
        createdAt,
        dueAt: at(type.slaSeconds),
        assigneeId: handled ? waiter.id : null,
        assignedAt: handled ? at(acceptAfter) : null,
        acceptedAt: status === 'accepted' || status === 'in_progress' || status === 'resolved' ? at(acceptAfter) : null,
        startedAt: status === 'in_progress' || status === 'resolved' ? at(startAfter) : null,
        resolvedAt: status === 'resolved' ? at(resolveAfter) : null,
        cancelledAt: status === 'cancelled' ? at(between(20, 90)) : null,
        escalationStatus: options.escalated ? 'escalated' : 'none',
        escalatedAt: options.escalated ? at(300) : null,
      },
    });
    if (lines.length > 0) {
      await prisma.serviceRequestItem.createMany({ data: lines.map((line) => ({ ...scoped, requestId: created.id, ...line })) });
    }
    const event = (type_: string, seconds: number, from: RequestStatus | null, to: RequestStatus, staff: boolean) =>
      events.push({ ...scoped, requestId: created.id, type: type_, fromStatus: from, toStatus: to, actorType: staff ? 'staff' : 'customer', actorId: staff ? waiter.id : null, createdAt: at(seconds) });
    event('request.created', 0, null, 'pending', false);
    if (status === 'cancelled') event('request.cancelled', 60, 'pending', 'cancelled', false);
    if (handled) {
      event('request.assigned', acceptAfter, 'pending', 'assigned', true);
      if (status !== 'assigned') event('request.accepted', acceptAfter, 'assigned', 'accepted', true);
      if (status === 'in_progress' || status === 'resolved') event('request.started', startAfter, 'accepted', 'in_progress', true);
      if (status === 'resolved') event('request.resolved', resolveAfter, 'in_progress', 'resolved', true);
    }
    if (options.escalated) {
      events.push({ ...scoped, requestId: created.id, type: 'request.escalated', actorType: 'system', createdAt: at(300), payload: { rule: 'Non prise en charge après 5 min' } });
    }
    await prisma.serviceRequestEvent.createMany({ data: events });
  }

  // Sept jours d'historique : services du midi et du soir.
  const now = Date.now();
  for (let day = 7; day >= 1; day -= 1) {
    const count = Math.round(between(14, 30));
    for (let i = 0; i < count; i += 1) {
      const midnight = new Date(now - day * 86_400_000);
      midnight.setUTCHours(0, 0, 0, 0);
      const hour = Math.random() < 0.45 ? between(12, 14.5) : between(19, 22.5);
      const createdAt = new Date(midnight.getTime() + hour * 3_600_000);
      await request(createdAt, Math.random() < 0.07 ? 'cancelled' : 'resolved', { order: Math.random() < 0.4 });
    }
  }
  // Aujourd'hui : quelques demandes terminées et la situation en cours.
  for (let i = 0; i < 9; i += 1) await request(new Date(now - between(40, 180) * 60_000), 'resolved', { order: i % 3 === 0 });
  await request(new Date(now - 90_000), 'pending', { table: 3, order: true });
  await request(new Date(now - 240_000), 'accepted', { table: 11, order: true, acceptAfter: 60 });
  await request(new Date(now - 35_000), 'pending', { table: 0, type: 1 });
  await request(new Date(now - 130_000), 'pending', { table: 9, type: 0 });
  await request(new Date(now - 270_000), 'pending', { table: 4, type: 2 });
  await request(new Date(now - 420_000), 'pending', { table: 13, type: 3, escalated: true });
  await request(new Date(now - 200_000), 'accepted', { table: 2, type: 2, acceptAfter: 70 });
  await request(new Date(now - 360_000), 'in_progress', { table: 10, type: 4, acceptAfter: 95 });
  await request(new Date(now - 150_000), 'in_progress', { table: 6, type: 1, acceptAfter: 40 });

  console.log(`Jeu de démonstration créé : ${people.map((p) => p.email).join(', ')} (mot de passe : celui de DEMO_PASSWORD).`);
}

main()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
