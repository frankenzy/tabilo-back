import { createPlatformAdmin } from '../src/resources/platform/platform';
import { PrivacyService } from '../src/resources/privacy/privacy';
import { Account, addStaff, createTable, Guest, openSession, registerTenant, startApp, TestApp, unique } from './helpers';

/**
 * Specs 038 à 041 — options et suppléments, créneaux, export des ventes, données et conformité.
 * Chaque test cite le critère couvert.
 */
describe('Specs 038 à 041', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await startApp();
    const email = `${unique('admin')}@tabilo.test`;
    await createPlatformAdmin(t.prisma, email, 'Francis', 'mot-de-passe-plateforme-1');
    const res = await t.http.post('/api/v1/platform/auth/login').send({ email, password: 'mot-de-passe-plateforme-1' }).expect(200);
    cookie = (res.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('tabilo_pf='))!.split(';')[0];
  });
  afterAll(() => t.close());

  interface Item {
    id: string;
    optionGroups: { id: string; name: string; options: { id: string; name: string; priceMinor: number }[] }[];
  }

  const POISSON_OPTIONS = [
    { name: 'Taille', multiple: false, required: true, options: [{ name: 'Petit', priceMinor: 0 }, { name: 'Moyen', priceMinor: 1000 }, { name: 'Gros', priceMinor: 2500 }] },
    { name: 'Accompagnement', multiple: false, required: true, options: [{ name: 'Attiéké', priceMinor: 0 }, { name: 'Alloco', priceMinor: 0 }, { name: 'Frites', priceMinor: 300 }] },
    { name: 'Suppléments', multiple: true, required: false, options: [{ name: 'Œuf', priceMinor: 200 }, { name: 'Sauce en plus', priceMinor: 100 }] },
  ];

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Grillades' }).expect(201)).body.id as string;
    const poisson = (
      await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Poisson braisé', priceMinor: 3000, optionGroups: POISSON_OPTIONS }).expect(201)
    ).body as Item;
    const biere = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Bière', priceMinor: 700 }).expect(201)).body as Item;
    const table = await createTable(t, owner, '1');
    const guest = await openSession(t, table.code);
    const pick = (item: Item, ...names: string[]) => item.optionGroups.flatMap((group) => group.options).filter((option) => names.includes(option.name)).map((option) => option.id);
    const order = (lines: unknown[], who: Guest = guest) => t.http.post('/api/v1/guest/orders').set(who.headers).send({ items: lines });
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({});
    const serve = async (id: string) => {
      await act(id, 'prepare').expect(200);
      await act(id, 'resolve').expect(200);
    };
    return { owner, menu, category, poisson, biere, guest, pick, order, serve };
  }

  const today = () => new Date().toISOString().slice(0, 10);

  // ------------------------------------------------------------------ 038

  it('CA-038-01 — créer des groupes d’options ; un groupe d’une option ou 5 groupes refusés', async () => {
    const { owner, menu, category, poisson } = await shop('Options création');
    expect(poisson.optionGroups.map((group) => group.name)).toEqual(['Taille', 'Accompagnement', 'Suppléments']);
    const one = [{ name: 'Taille', multiple: false, required: true, options: [{ name: 'Petit', priceMinor: 0 }] }];
    await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'X', priceMinor: 100, optionGroups: one }).expect(400);
    const five = Array.from({ length: 5 }, () => POISSON_OPTIONS[2]);
    await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Y', priceMinor: 100, optionGroups: five }).expect(400);
  });

  it('CA-038-02 et CA-038-04 — prix avec suppléments, une ligne par combinaison', async () => {
    const { poisson, pick, order } = await shop('Options prix');
    const res = await order([
      { menuItemId: poisson.id, quantity: 1, options: pick(poisson, 'Moyen', 'Alloco', 'Œuf') },
      { menuItemId: poisson.id, quantity: 1, options: pick(poisson, 'Gros', 'Frites') },
    ]).expect(200);
    const lines = res.body.request.items as { unitPriceMinor: number; options: { name: string }[] }[];
    expect(lines.map((line) => line.unitPriceMinor).sort()).toEqual([4200, 5800]);
    expect(res.body.request.totalMinor).toBe(10000);
    expect(lines.find((line) => line.unitPriceMinor === 4200)!.options.map((o) => o.name)).toEqual(['Moyen', 'Alloco', 'Œuf']);
  });

  it('CA-038-03 — choix contrôlés', async () => {
    const { poisson, biere, pick, order, owner, menu, category } = await shop('Options contrôle');
    const code = async (options: string[]) => (await order([{ menuItemId: poisson.id, quantity: 1, options }]).expect(422)).body.code;
    expect(await code(pick(poisson, 'Alloco'))).toBe('OPTION_CHOICE_INVALID');
    expect(await code(pick(poisson, 'Petit', 'Moyen', 'Alloco'))).toBe('OPTION_CHOICE_INVALID');
    const other = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Autre', priceMinor: 100, optionGroups: [POISSON_OPTIONS[2]] }).expect(201)).body as Item;
    expect(await code([...pick(poisson, 'Petit', 'Alloco'), other.optionGroups[0].options[0].id])).toBe('OPTION_CHOICE_INVALID');
    expect((await order([{ menuItemId: biere.id, quantity: 1, options: pick(poisson, 'Petit') }]).expect(422)).body.code).toBe('OPTION_CHOICE_INVALID');
  });

  it('CA-038-05 et CA-038-07 — figé, puis rupture quand toutes les tailles sont indisponibles', async () => {
    const { owner, menu, poisson, pick, order, guest } = await shop('Options figées');
    const first = await order([{ menuItemId: poisson.id, quantity: 1, options: pick(poisson, 'Petit', 'Attiéké', 'Œuf') }]).expect(200);
    const groups = poisson.optionGroups.map((group, index) => ({
      ...POISSON_OPTIONS[index],
      options: group.options.map((option) => ({
        id: option.id, name: option.name, priceMinor: option.name === 'Œuf' ? 300 : option.priceMinor, isAvailable: group.name !== 'Taille',
      })),
    }));
    await t.http.patch(`${menu}/items/${poisson.id}`).set(owner.auth).send({ optionGroups: groups }).expect(200);
    const kept = await t.http.get(`${owner.base}/requests/${first.body.request.id}`).set(owner.auth).expect(200);
    expect(kept.body.items[0].unitPriceMinor).toBe(3200);
    const seen = ((await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200)).body.menu as { items: { id: string; isAvailable: boolean }[] }[])
      .flatMap((c) => c.items).find((item) => item.id === poisson.id)!;
    expect(seen.isAvailable).toBe(false);
  });

  it('CA-038-06 et CA-038-08 — options côté personnel et ventes par option', async () => {
    const { owner, poisson, pick, order, serve } = await shop('Options ventes');
    for (const size of ['Moyen', 'Moyen', 'Moyen', 'Gros']) {
      const res = await order([{ menuItemId: poisson.id, quantity: 1, options: pick(poisson, size, 'Attiéké') }]).expect(200);
      await serve(res.body.request.id);
    }
    const detail = (await t.http.get(`${owner.base}/requests`).query({ scope: 'all' }).set(owner.auth).expect(200)).body.items[0];
    expect(detail.items[0].options.length).toBeGreaterThan(0);
    const rows = (await t.http.get(`${owner.base}/analytics/options`).query({ from: today(), to: today() }).set(owner.auth).expect(200)).body as {
      option: string; quantity: number; amountMinor: number;
    }[];
    expect(rows.find((row) => row.option === 'Moyen')).toMatchObject({ quantity: 3, amountMinor: 3000 });
    expect(rows.find((row) => row.option === 'Gros')).toMatchObject({ quantity: 1, amountMinor: 2500 });
  });

  // ------------------------------------------------------------------ 039

  it('CA-039-03 — disponible seulement sur un créneau', async () => {
    const { owner, menu, biere, order } = await shop('Créneau dispo');
    const now = new Date();
    const hour = (now.getUTCHours() + 3) % 24;
    const slot = { days: [1, 2, 3, 4, 5, 6, 7], start: `${String(hour).padStart(2, '0')}:00`, end: `${String((hour + 1) % 24).padStart(2, '0')}:00` };
    await t.http.patch(`${menu}/items/${biere.id}`).set(owner.auth).send({ availabilitySlots: [slot] }).expect(200);
    expect((await order([{ menuItemId: biere.id, quantity: 1 }]).expect(422)).body.code).toBe('MENU_ITEM_UNAVAILABLE');
    await t.http.patch(`${menu}/items/${biere.id}`).set(owner.auth).send({ availabilitySlots: null }).expect(200);
    await order([{ menuItemId: biere.id, quantity: 1 }]).expect(200);
  });

  it('CA-039-01 — promotion programmée : prix promo dans le créneau, prix normal dehors', async () => {
    const { owner, menu, biere, order } = await shop('Happy hour');
    const all = [1, 2, 3, 4, 5, 6, 7];
    const inside = { days: all, start: '00:00', end: '23:45' };
    await t.http.patch(`${menu}/items/${biere.id}`).set(owner.auth).send({ promoPriceMinor: 500, promoSlots: [inside], promoName: 'Happy hour' }).expect(200);
    const during = await order([{ menuItemId: biere.id, quantity: 1 }]).expect(200);
    // Le créneau couvre presque toute la journée : la commande est dedans, sauf entre 23 h 45 et minuit (UTC).
    const late = new Date().getUTCHours() === 23 && new Date().getUTCMinutes() >= 45;
    expect(during.body.request.totalMinor).toBe(late ? 700 : 500);
    const hour = (new Date().getUTCHours() + 3) % 24;
    const outside = { days: all, start: `${String(hour).padStart(2, '0')}:00`, end: `${String((hour + 1) % 24).padStart(2, '0')}:00` };
    await t.http.patch(`${menu}/items/${biere.id}`).set(owner.auth).send({ promoSlots: [outside] }).expect(200);
    expect((await order([{ menuItemId: biere.id, quantity: 1 }]).expect(200)).body.request.totalMinor).toBe(700);
  });

  it('CA-039-05 — créneaux contrôlés', async () => {
    const { owner, menu, biere } = await shop('Créneaux invalides');
    const send = (availabilitySlots: unknown) => t.http.patch(`${menu}/items/${biere.id}`).set(owner.auth).send({ availabilitySlots });
    await send([{ days: [], start: '17:00', end: '19:00' }]).expect(400);
    await send([{ days: [1], start: '17:10', end: '19:00' }]).expect(400);
    const ok = { days: [1], start: '17:00', end: '19:00' };
    await send([ok, ok, ok, ok]).expect(400);
  });

  // ------------------------------------------------------------------ 040

  it('CA-040-01 et CA-040-05 — CSV : BOM, point-virgule, total égal aux ventes ; journal', async () => {
    const { owner, biere, order, serve } = await shop('Export CSV');
    for (let i = 0; i < 3; i += 1) {
      const res = await order([{ menuItemId: biere.id, quantity: 2 }]).expect(200);
      await serve(res.body.request.id);
    }
    const res = await t.http.get(`${owner.base}/analytics/export.csv`).query({ from: today(), to: today() }).set(owner.auth).buffer(true).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('Commande;Date;Heure');
    const total = lines.slice(1).reduce((sum, line) => sum + Number(line.split(';')[7]), 0);
    const summary = (await t.http.get(`${owner.base}/analytics/summary`).query({ from: today(), to: today() }).set(owner.auth).expect(200)).body;
    expect(total).toBe(4200);
    expect(summary).toMatchObject({ totalMinor: 4200, orders: 3 });
    expect(summary.topProducts[0]).toMatchObject({ name: 'Bière', quantity: 6 });
    const logs = await t.prisma.auditLog.count({ where: { establishmentId: owner.establishmentId, action: 'analytics.exported' } });
    expect(logs).toBe(2);
  });

  it('CA-040-02 et CA-040-04 — période contrôlée, droits et formule', async () => {
    const { owner } = await shop('Export droits');
    await t.http.get(`${owner.base}/analytics/export.csv`).query({ from: '2026-01-01', to: '2026-06-01' }).set(owner.auth).expect(422);
    await t.http.get(`${owner.base}/analytics/export.csv`).query({ from: '2026-11-10', to: '2026-11-01' }).set(owner.auth).expect(422);
    const waiter = await addStaff(t, owner, 'waiter');
    await t.http.get(`${waiter.base}/analytics/summary`).query({ from: today(), to: today() }).set(waiter.auth).expect(403);
    await t.prisma.tenant.updateMany({ where: { users: { some: { id: owner.userId } } }, data: { plan: 'essentiel' } });
    expect((await t.http.get(`${owner.base}/analytics/summary`).query({ from: today(), to: today() }).set(owner.auth).expect(403)).body.code).toBe('PLAN_FEATURE_LOCKED');
  });

  // ------------------------------------------------------------------ 041

  it('CA-041-01 — acceptation obligatoire à l’inscription, version enregistrée', async () => {
    const body = { organizationName: 'Sans CGU SARL', establishmentName: 'Sans CGU', firstName: 'A', lastName: 'B', email: `${unique('cgu')}@example.test`, password: 'Motdepasse-solide-1' };
    await t.http.post('/api/v1/auth/register').send(body).expect(400);
    const owner = await registerTenant(t, 'Avec CGU');
    const tenant = await t.prisma.tenant.findFirstOrThrow({ where: { users: { some: { id: owner.userId } } } });
    expect(tenant.termsVersion).toBeTruthy();
    expect(tenant.termsAcceptedAt).not.toBeNull();
  });

  it('CA-041-02 — nouvelle version : le propriétaire l’accepte', async () => {
    const owner = await registerTenant(t, 'Nouvelle version');
    await t.prisma.tenant.updateMany({ where: { users: { some: { id: owner.userId } } }, data: { termsVersion: '2020-01-01' } });
    const me = (await t.http.get('/api/v1/auth/me').set(owner.auth).expect(200)).body;
    expect(me.account.termsVersion).not.toBe(me.account.legalVersion);
    await t.http.post('/api/v1/auth/accept-terms').set(owner.auth).send({}).expect(200);
    const after = (await t.http.get('/api/v1/auth/me').set(owner.auth).expect(200)).body;
    expect(after.account.termsVersion).toBe(after.account.legalVersion);
    const manager = await addStaff(t, owner, 'manager');
    await t.http.post('/api/v1/auth/accept-terms').set(manager.auth).send({}).expect(403);
  });

  it('CA-041-03 — export ZIP sans secret, une fois par heure, propriétaire seulement', async () => {
    const { owner, biere, order } = await shop('Export données');
    await order([{ menuItemId: biere.id, quantity: 1 }]).expect(200);
    const res = await t.http
      .get(`${owner.base}/subscription/export`)
      .set(owner.auth)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const archive = res.body as Buffer;
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const text = archive.toString('utf8');
    for (const name of ['carte.csv', 'tables.csv', 'equipe.csv', 'commandes.csv', 'donnees.json']) expect(text).toContain(name);
    expect(text).not.toMatch(/passwordHash|tokenHash|\$argon2/);
    expect((await t.http.get(`${owner.base}/subscription/export`).set(owner.auth).expect(429)).body.code).toBe('EXPORT_TOO_SOON');
    const manager = await addStaff(t, owner, 'manager');
    await t.http.get(`${manager.base}/subscription/export`).set(manager.auth).expect(403);
  });

  it('CA-041-04 et CA-041-05 — fermer, rétablir, puis effacer à la fin du délai', async () => {
    const { owner, biere, order } = await shop(unique('Fermeture'));
    await order([{ menuItemId: biere.id, quantity: 1 }]).expect(200);
    const tenant = await t.prisma.tenant.findFirstOrThrow({ where: { users: { some: { id: owner.userId } } } });
    const platform = (path: string, body: object) => t.http.post(`/api/v1/platform${path}`).set('Cookie', cookie).send(body);
    await platform(`/tenants/${tenant.id}/payments`, { amountMinor: 35000, method: 'wave', reference: 'TX-9', months: 1, plan: 'pro' }).expect(201);
    expect((await platform(`/tenants/${tenant.id}/close`, { confirmName: 'Autre nom', reason: 'Demande du client' }).expect(422)).body.code).toBe('CONFIRM_NAME_MISMATCH');
    await platform(`/tenants/${tenant.id}/close`, { confirmName: tenant.name, reason: 'Demande du client' }).expect(200);
    await t.http.post('/api/v1/auth/login').send({ email: owner.email, password: 'Motdepasse-solide-1' }).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    await platform(`/tenants/${tenant.id}/restore`, { reason: 'Le client revient' }).expect(200);
    await t.http.post('/api/v1/auth/login').send({ email: owner.email, password: 'Motdepasse-solide-1' }).expect(200);

    await platform(`/tenants/${tenant.id}/close`, { confirmName: tenant.name, reason: 'Départ confirmé', days: 7 }).expect(200);
    await t.app.get(PrivacyService).eraseDue(new Date(Date.now() + 8 * 86_400_000));
    const erased = await t.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(erased).toMatchObject({ name: 'Compte supprimé' });
    expect(erased.erasedAt).not.toBeNull();
    expect(await t.prisma.user.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await t.prisma.serviceRequest.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await t.prisma.establishment.count({ where: { tenantId: tenant.id } })).toBe(0);
    const payments = await t.prisma.subscriptionPayment.findMany({ where: { tenantId: tenant.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].reference).toBeNull();
  });

  it('CA-041-06 — purge des adresses IP de plus de 12 mois', async () => {
    const owner: Account = await registerTenant(t, 'Purge');
    const old = await t.prisma.auditLog.create({ data: { action: 'test.old', tenantId: (await t.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).tenantId, ip: '1.2.3.4', createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    const recent = await t.prisma.auditLog.create({ data: { action: 'test.recent', ip: '5.6.7.8', createdAt: new Date(Date.now() - 330 * 86_400_000) } });
    await t.app.get(PrivacyService).purge();
    expect((await t.prisma.auditLog.findUniqueOrThrow({ where: { id: old.id } })).ip).toBeNull();
    expect((await t.prisma.auditLog.findUniqueOrThrow({ where: { id: recent.id } })).ip).toBe('5.6.7.8');
  });
});
