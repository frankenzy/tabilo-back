import { Account, addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

interface TableCard {
  id: string;
  label: string;
  seats: number;
  areaName: string;
  status: 'occupied' | 'free';
  amountMinor: number | null;
}

/**
 * Spec 006 — Vue « Tables » pour le gérant et le propriétaire.
 * Chaque test cite le critère d'acceptation qu'il couvre (specs/006-vue-tables/spec.md).
 */
describe('Spec 006 — vue des tables', () => {
  let t: TestApp;
  let owner: Account;
  let manager: Account;
  let waiter: Account;
  let prices: Record<number, string>;

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'Maquis des Tables');
    manager = await addStaff(t, owner, 'manager', 'Mariam');
    waiter = await addStaff(t, owner, 'waiter', 'Koffi');
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    prices = {};
    for (const priceMinor of [2000, 3000, 4500]) {
      const item = await t.http
        .post(`${owner.base}/menu/items`)
        .set(owner.auth)
        .send({ categoryId: category.body.id, name: `Plat ${priceMinor}`, priceMinor })
        .expect(201);
      prices[priceMinor] = item.body.id as string;
    }
  });
  afterAll(() => t.close());

  const overview = (who: Account) => t.http.get(`${who.base}/tables/overview`).set(who.auth);
  const card = async (who: Account, id: string) =>
    ((await overview(who).expect(200)).body.tables as TableCard[]).find((table) => table.id === id)!;

  async function order(code: string, priceMinor: number): Promise<string> {
    const guest = await openSession(t, code);
    const res = await t.http
      .post('/api/v1/guest/orders')
      .set(guest.headers)
      .send({ items: [{ menuItemId: prices[priceMinor], quantity: 1 }] })
      .expect(200);
    return res.body.request.id as string;
  }

  it('CA-006-02 — refuse la vue au serveur, l’ouvre au gérant et au propriétaire', async () => {
    const res = await overview(waiter).expect(403);
    expect(res.body.code).toBeDefined();
    await overview(manager).expect(200);
    await overview(owner).expect(200);
  });

  it('CA-006-03 — une table avec une session ouverte est occupée', async () => {
    const table = await createTable(t, owner, 'T3');
    await openSession(t, table.code);
    expect((await card(manager, table.tableId)).status).toBe('occupied');
  });

  it('CA-006-04 — une table sans session ouverte est libre, sans montant', async () => {
    const table = await createTable(t, owner, 'T4');
    const free = await card(manager, table.tableId);
    expect(free.status).toBe('free');
    expect(free.amountMinor).toBeNull();
  });

  it('CA-006-05 — le montant additionne les commandes non annulées de la session en cours', async () => {
    const table = await createTable(t, owner, 'T5');
    await order(table.code, 3000);
    await order(table.code, 4500);
    const cancelled = await order(table.code, 2000);
    await t.http.post(`${owner.base}/requests/${cancelled}/cancel`).set(owner.auth).send({}).expect(200);
    expect((await card(manager, table.tableId)).amountMinor).toBe(7500);
  });

  it('CA-006-05 — une commande passée avant l’arrivée des clients actuels ne compte pas', async () => {
    const table = await createTable(t, owner, 'T6');
    const previous = await order(table.code, 3000);
    // Les clients précédents ont été servis, puis sont partis.
    await t.http.post(`${owner.base}/requests/${previous}/prepare`).set(owner.auth).send({}).expect(200);
    await t.http.post(`${owner.base}/requests/${previous}/resolve`).set(owner.auth).send({}).expect(200);
    await t.http.post(`${owner.base}/tables/${table.tableId}/sessions/close`).set(owner.auth).send({}).expect(200);
    expect((await card(manager, table.tableId)).status).toBe('free');
    await openSession(t, table.code);
    const again = await card(manager, table.tableId);
    expect(again.status).toBe('occupied');
    expect(again.amountMinor).toBe(0);
  });

  it('CA-006-07 — compte les commandes non annulées du jour et toutes les tables actives', async () => {
    const before = (await overview(manager).expect(200)).body as { ordersToday: number; tables: TableCard[] };
    const table = await createTable(t, owner, 'T7');
    await order(table.code, 2000);
    const cancelled = await order(table.code, 3000);
    await t.http.post(`${owner.base}/requests/${cancelled}/cancel`).set(owner.auth).send({}).expect(200);
    const after = (await overview(manager).expect(200)).body as { ordersToday: number; tables: TableCard[]; currency: string };
    expect(after.ordersToday).toBe(before.ordersToday + 1);
    expect(after.tables).toHaveLength(before.tables.length + 1);
    expect(after.currency).toBe('XOF');
  });

  it('CA-006-07 — une table supprimée disparaît de la vue', async () => {
    const table = await createTable(t, owner, 'T8');
    await t.http.delete(`${owner.base}/tables/${table.tableId}`).set(owner.auth).expect(204);
    const tables = (await overview(manager).expect(200)).body.tables as TableCard[];
    expect(tables.some((row) => row.id === table.tableId)).toBe(false);
  });

  it('CA-006-14 — une commande en cours garde la table occupée, avec son montant, même sans session ouverte', async () => {
    const table = await createTable(t, owner, 'T9');
    const id = await order(table.code, 4500);
    await t.http.post(`${owner.base}/requests/${id}/prepare`).set(owner.auth).send({}).expect(200);
    // Le téléphone du client se déconnecte : sa session est fermée, la commande reste à servir.
    await t.http.post(`${owner.base}/tables/${table.tableId}/sessions/close`).set(owner.auth).send({}).expect(200);
    const busy = await card(manager, table.tableId);
    expect(busy.status).toBe('occupied');
    expect(busy.amountMinor).toBe(4500);
    await t.http.post(`${owner.base}/requests/${id}/resolve`).set(owner.auth).send({}).expect(200);
    expect((await card(manager, table.tableId)).status).toBe('free');
  });
});
