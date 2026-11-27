import { createPlatformAdmin } from '../src/resources/platform/platform';
import { SubscriptionService } from '../src/resources/subscription/subscription';
import { Account, addStaff, createTable, openSession, registerTenant, startApp, TestApp, unique } from './helpers';

/**
 * Specs 034 à 037 — formules d'abonnement, essai et suspension, console de la plateforme, encaissement.
 * Chaque test cite le critère couvert.
 */
describe('Specs 034 à 037 — abonnements', () => {
  let t: TestApp;
  let cookie: string;
  const DAY = 86_400_000;

  beforeAll(async () => {
    t = await startApp();
    const email = `${unique('admin')}@tabilo.test`;
    await createPlatformAdmin(t.prisma, email, 'Francis', 'mot-de-passe-plateforme-1');
    const res = await t.http.post('/api/v1/platform/auth/login').send({ email, password: 'mot-de-passe-plateforme-1' }).expect(200);
    cookie = (res.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('tabilo_pf='))!.split(';')[0];
  });
  afterAll(() => t.close());

  const platform = (method: 'get' | 'post', path: string) => t.http[method](`/api/v1/platform${path}`).set('Cookie', cookie);
  const tenantOf = (account: Account) => t.prisma.tenant.findFirstOrThrow({ where: { users: { some: { id: account.userId } } } });
  const setPlan = async (account: Account, plan: 'essentiel' | 'pro' | 'premium') =>
    t.prisma.tenant.update({ where: { id: (await tenantOf(account)).id }, data: { plan } });

  // ------------------------------------------------------------------ 034

  it('CA-035-01 — l’inscription ouvre un essai Pro de 7 jours', async () => {
    const owner = await registerTenant(t, 'Essai');
    const tenant = await tenantOf(owner);
    expect(tenant).toMatchObject({ plan: 'pro', accountState: 'trial' });
    const days = (tenant.paidUntil.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const me = await t.http.get('/api/v1/auth/me').set(owner.auth).expect(200);
    expect(me.body.account).toMatchObject({ plan: 'pro', state: 'trial', contact: '+225 05 84 77 73 67' });
  });

  it('CA-034-02 — limite de tables, l’archivage libère une place', async () => {
    const owner = await registerTenant(t, 'Limite tables');
    await setPlan(owner, 'essentiel');
    const first = await createTable(t, owner, 'L1');
    for (let i = 2; i <= 15; i += 1) {
      await t.http.post(`${owner.base}/tables`).set(owner.auth).send({ areaId: first.areaId, label: `L${i}` }).expect(201);
    }
    const refused = await t.http.post(`${owner.base}/tables`).set(owner.auth).send({ areaId: first.areaId, label: 'L16' }).expect(403);
    expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');
    expect(await t.prisma.diningTable.count({ where: { establishmentId: owner.establishmentId, archivedAt: null } })).toBe(15);
    // Une table archivée ne compte plus.
    await t.prisma.diningTable.update({ where: { id: first.tableId }, data: { archivedAt: new Date() } });
    await t.http.post(`${owner.base}/tables`).set(owner.auth).send({ areaId: first.areaId, label: 'L16' }).expect(201);
  });

  it('CA-034-03 — limite d’équipe et d’établissements', async () => {
    const owner = await registerTenant(t, 'Limite équipe');
    await setPlan(owner, 'essentiel');
    for (let i = 0; i < 4; i += 1) await addStaff(t, owner, 'waiter', `Serveur${i}`);
    const role = (await t.http.get(`${owner.base}/roles`).set(owner.auth).expect(200)).body.find((r: { key: string }) => r.key === 'waiter').id as string;
    const refused = await t.http
      .post(`${owner.base}/staff`)
      .set(owner.auth)
      .send({ email: `${unique('six')}@tabilo.test`, firstName: 'Six', lastName: 'Six', roleId: role, password: 'Motdepasse-solide-1' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');
    const second = await t.http.post('/api/v1/establishments').set(owner.auth).send({ name: 'Deuxième maquis' }).expect(403);
    expect(second.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('CA-034-04 et CA-034-05 — modules fermés en Essentiel, le client n’est pas bloqué', async () => {
    const owner = await registerTenant(t, 'Modules');
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Midi' }).expect(201)).body.id as string;
    const garba = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Garba', priceMinor: 1500 }).expect(201)).body;
    const bundle = (
      await t.http
        .post(`${menu}/items`)
        .set(owner.auth)
        .send({ categoryId: category, name: 'Menu midi', priceMinor: 2000, groups: [{ name: 'Plat', choiceIds: [garba.id] }] })
        .expect(201)
    ).body;
    await setPlan(owner, 'essentiel');
    const locked = await t.http
      .post(`${menu}/items`)
      .set(owner.auth)
      .send({ categoryId: category, name: 'Autre', priceMinor: 2000, groups: [{ name: 'Plat', choiceIds: [garba.id] }] })
      .expect(403);
    expect(locked.body.code).toBe('PLAN_FEATURE_LOCKED');
    expect((await t.http.patch(`${menu}/items/${garba.id}`).set(owner.auth).send({ promoPriceMinor: 1000 }).expect(403)).body.code).toBe('PLAN_FEATURE_LOCKED');
    expect((await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'year' }).set(owner.auth).expect(403)).body.code).toBe('PLAN_FEATURE_LOCKED');
    // R5 : la formule déjà à la carte se commande toujours.
    const table = await createTable(t, owner, '1');
    const guest = await openSession(t, table.code);
    await t.http
      .post('/api/v1/guest/orders')
      .set(guest.headers)
      .send({ items: [{ menuItemId: bundle.id, quantity: 1, choices: [{ groupId: bundle.groups[0].id, menuItemId: garba.id }] }] })
      .expect(200);
  });

  it('CA-034-01 et CA-034-06 — page « Abonnement » : formule, compteurs, cadenas ; réservée au propriétaire', async () => {
    const owner = await registerTenant(t, 'Page abonnement');
    await setPlan(owner, 'essentiel');
    await createTable(t, owner, '1');
    const page = (await t.http.get(`${owner.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(page).toMatchObject({ plan: 'essentiel', usage: { tables: { used: 1, max: 15 } } });
    expect(page.features.find((f: { key: string }) => f.key === 'bundles')).toMatchObject({ included: false, availableIn: 'Pro' });
    expect(page.catalog.map((plan: { monthlyPriceMinor: number }) => plan.monthlyPriceMinor)).toEqual([15000, 35000, 75000]);
    const manager = await addStaff(t, owner, 'manager');
    await t.http.get(`${manager.base}/subscription`).set(manager.auth).expect(403);
  });

  // ------------------------------------------------------------------ 035

  it('CA-035-03 — en retard le lendemain de l’échéance, suspendu 7 jours plus tard', async () => {
    const owner = await registerTenant(t, 'Échéance');
    const tenant = await tenantOf(owner);
    const service = t.app.get(SubscriptionService);
    await t.prisma.tenant.update({ where: { id: tenant.id }, data: { paidUntil: new Date(Date.now() - DAY) } });
    await service.sweep();
    expect((await tenantOf(owner)).accountState).toBe('past_due');
    const table = await createTable(t, owner, '1');
    await openSession(t, table.code);
    await t.prisma.tenant.update({ where: { id: tenant.id }, data: { paidUntil: new Date(Date.now() - 8 * DAY) } });
    await service.sweep();
    expect((await tenantOf(owner)).accountState).toBe('suspended');
    const log = await t.prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: 'subscription.state_changed' } });
    expect(log).toHaveLength(2);
  });

  it('CA-035-04 — compte suspendu : QR indisponible, espace pro fermé sauf « Abonnement »', async () => {
    const owner = await registerTenant(t, 'Suspendu');
    const table = await createTable(t, owner, '1');
    const guest = await openSession(t, table.code);
    await t.prisma.tenant.update({ where: { id: (await tenantOf(owner)).id }, data: { accountState: 'suspended' } });
    expect((await t.http.post('/api/v1/guest/sessions').send({ code: table.code }).expect(403)).body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await t.http.get('/api/v1/guest/session').set(guest.headers).expect(403)).body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await t.http.get(`${owner.base}/menu`).set(owner.auth).expect(403)).body.code).toBe('ACCOUNT_SUSPENDED');
    await t.http.get(`${owner.base}/subscription`).set(owner.auth).expect(200);
    await t.http.get('/api/v1/auth/me').set(owner.auth).expect(200);
  });

  // ------------------------------------------------------------------ 036

  it('CA-036-01 — liste des comptes, filtre « En retard »', async () => {
    const owner = await registerTenant(t, unique('Retard'));
    const id = (await tenantOf(owner)).id;
    await t.prisma.tenant.update({ where: { id }, data: { accountState: 'past_due' } });
    const list = (await platform('get', '/tenants').query({ state: 'past_due' }).expect(200)).body as { id: string; accountState: string; planName: string }[];
    expect(list.every((row) => row.accountState === 'past_due')).toBe(true);
    expect(list.find((row) => row.id === id)).toMatchObject({ planName: 'Pro', accountState: 'past_due' });
  });

  it('CA-036-02 — routes réservées : un propriétaire est refusé', async () => {
    const owner = await registerTenant(t, 'Intrus');
    await t.http.get('/api/v1/platform/tenants').set(owner.auth).expect(404);
    await t.http.get('/api/v1/platform/tenants').expect(404);
    // Le cookie de la console n'ouvre aucune route d'établissement.
    await t.http.get(`${owner.base}/menu`).set('Cookie', cookie).expect(401);
  });

  it('CA-036-03 et CA-036-04 — changer de formule, prolonger, suspendre avec motif, réactiver', async () => {
    const owner = await registerTenant(t, 'Console actions');
    const id = (await tenantOf(owner)).id;
    await platform('post', `/tenants/${id}/plan`).send({ plan: 'premium' }).expect(200);
    const before = (await tenantOf(owner)).paidUntil.getTime();
    await platform('post', `/tenants/${id}/extend`).send({ days: 15 }).expect(200);
    expect((await tenantOf(owner)).paidUntil.getTime() - before).toBe(15 * DAY);
    await platform('post', `/tenants/${id}/suspend`).send({}).expect(400);
    await platform('post', `/tenants/${id}/suspend`).send({ reason: 'Impayé constaté' }).expect(200);
    expect((await tenantOf(owner)).accountState).toBe('suspended');
    await t.http.get(`${owner.base}/menu`).set(owner.auth).expect(403);
    await platform('post', `/tenants/${id}/reactivate`).send({ reason: 'Accord trouvé' }).expect(200);
    expect((await tenantOf(owner)).accountState).toBe('trial');
    const platformLog = await t.prisma.platformAuditLog.findMany({ where: { tenantId: id } });
    expect(platformLog.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['platform.plan_changed', 'platform.extended', 'platform.suspended', 'platform.reactivated']),
    );
    const tenantLog = await t.prisma.auditLog.findMany({ where: { tenantId: id, action: { startsWith: 'platform.' } } });
    expect(tenantLog.length).toBeGreaterThanOrEqual(4);
    expect(tenantLog.every((entry) => entry.actorId === null)).toBe(true);
  });

  it('CA-036-05 — lien de réinitialisation : une fois, sessions fermées', async () => {
    const owner = await registerTenant(t, 'Mot de passe oublié');
    const id = (await tenantOf(owner)).id;
    const link = (await platform('post', `/tenants/${id}/owners/${owner.userId}/reset-link`).expect(200)).body as { url: string };
    const token = new URL(link.url).searchParams.get('jeton')!;
    await t.http.post('/api/v1/auth/reset-password').send({ token, password: 'Nouveau-mot-de-passe-2' }).expect(204);
    expect(await t.prisma.refreshSession.count({ where: { userId: owner.userId, revokedAt: null } })).toBe(0);
    await t.http.post('/api/v1/auth/login').send({ email: owner.email, password: 'Nouveau-mot-de-passe-2' }).expect(200);
    expect((await t.http.post('/api/v1/auth/reset-password').send({ token, password: 'Encore-un-autre-3' }).expect(422)).body.code).toBe('RESET_LINK_INVALID');
  });

  it('CA-036-06 — pas de données métier dans la console', async () => {
    const owner = await registerTenant(t, 'Discrétion');
    const id = (await tenantOf(owner)).id;
    const body = JSON.stringify((await platform('get', `/tenants/${id}`).expect(200)).body);
    expect(body).not.toMatch(/menu|items|passwordHash|tokenHash/i);
  });

  // ------------------------------------------------------------------ 037

  it('CA-037-01 et CA-035-05 — un paiement prolonge, rend actif et crée un reçu', async () => {
    const owner = await registerTenant(t, 'Paiement');
    const id = (await tenantOf(owner)).id;
    await t.prisma.tenant.update({ where: { id }, data: { accountState: 'suspended', paidUntil: new Date(Date.now() - 20 * DAY) } });
    const receipt = (await platform('post', `/tenants/${id}/payments`).send({ amountMinor: 35000, method: 'wave', reference: 'TX-1', months: 1, plan: 'pro' }).expect(201)).body;
    expect(receipt.number).toMatch(/^\d{4}-\d{4}$/);
    const tenant = await tenantOf(owner);
    expect(tenant.accountState).toBe('active');
    // CA-037-02 : échéance passée, la période part du jour du paiement.
    const days = (tenant.paidUntil.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    await t.http.get(`${owner.base}/menu`).set(owner.auth).expect(200);
    const page = (await t.http.get(`${owner.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(page.payments[0]).toMatchObject({ number: receipt.number, amountMinor: 35000, method: 'wave' });
    await t.http.get(`${owner.base}/subscription/receipts/${receipt.id}`).set(owner.auth).expect(200);
  });

  it('CA-037-03 — deux paiements simultanés, numéros consécutifs', async () => {
    const owner = await registerTenant(t, 'Numéros');
    const id = (await tenantOf(owner)).id;
    const pay = () => platform('post', `/tenants/${id}/payments`).send({ amountMinor: 15000, method: 'cash', months: 1, plan: 'essentiel' });
    const [a, b] = await Promise.all([pay(), pay()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const numbers = [a.body.number, b.body.number].map((n: string) => Number(n.split('-')[1])).sort((x, y) => x - y);
    expect(numbers[1] - numbers[0]).toBe(1);
  });

  it('CA-037-04 — annuler un paiement : reçu « Annulé », échéance rétablie', async () => {
    const owner = await registerTenant(t, 'Annulation');
    const id = (await tenantOf(owner)).id;
    const before = (await tenantOf(owner)).paidUntil.toISOString();
    const receipt = (await platform('post', `/tenants/${id}/payments`).send({ amountMinor: 35000, method: 'orange_money', months: 3, plan: 'pro' }).expect(201)).body;
    await platform('post', `/payments/${receipt.id}/cancel`).send({}).expect(400);
    const cancelled = (await platform('post', `/payments/${receipt.id}/cancel`).send({ reason: 'Saisie en double' }).expect(200)).body;
    expect(cancelled).toMatchObject({ number: receipt.number, cancelReason: 'Saisie en double' });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect((await tenantOf(owner)).paidUntil.toISOString()).toBe(before);
  });

  it('CA-037-05 — reçus : propriétaire seulement, jamais ceux d’un autre compte', async () => {
    const owner = await registerTenant(t, 'Reçus');
    const other = await registerTenant(t, 'Reçus voisin');
    const receipt = (await platform('post', `/tenants/${(await tenantOf(other)).id}/payments`).send({ amountMinor: 15000, method: 'cash', months: 1, plan: 'essentiel' }).expect(201)).body;
    await t.http.get(`${owner.base}/subscription/receipts/${receipt.id}`).set(owner.auth).expect(404);
    const manager = await addStaff(t, other, 'manager');
    await t.http.get(`${manager.base}/subscription/receipts/${receipt.id}`).set(manager.auth).expect(403);
  });

  it('CA-037-06 — montant ou durée invalides refusés', async () => {
    const owner = await registerTenant(t, 'Invalide');
    const id = (await tenantOf(owner)).id;
    for (const body of [
      { amountMinor: 0, method: 'cash', months: 1, plan: 'pro' },
      { amountMinor: 1500.5, method: 'cash', months: 1, plan: 'pro' },
      { amountMinor: 35000, method: 'cash', months: 2, plan: 'pro' },
    ]) {
      await platform('post', `/tenants/${id}/payments`).send(body).expect(400);
    }
  });
});
