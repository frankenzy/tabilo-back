import { Account, addStaff, createTable, Floor, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 026 — Régler les commandes et libérer la table.
 * Chaque test cite le critère couvert (specs/026-reglement-commandes/spec.md).
 */
describe('Spec 026 — règlement des commandes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200 }).expect(200);
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const prices: Record<number, string> = {};
    for (const priceMinor of [1500, 2000, 3000, 4500]) {
      const item = await t.http.post(`${owner.base}/menu/items`).set(owner.auth).send({ categoryId: category.body.id, name: `Plat ${priceMinor}`, priceMinor }).expect(201);
      prices[priceMinor] = item.body.id as string;
    }
    const table = await createTable(t, owner, '3');
    let guest = await openSession(t, table.code);
    /** Spec 027, R4 : une session réglée est terminée ; le client suivant (ou le même) en ouvre une nouvelle. */
    async function currentGuest(): Promise<Guest> {
      const probe = await t.http.get('/api/v1/guest/session').set(guest.headers);
      if (probe.status === 401) guest = await openSession(t, table.code);
      return guest;
    }
    const act = (account: Account, id: string, action: string) => t.http.post(`${account.base}/requests/${id}/${action}`).set(account.auth).send({});

    /** Commande de la table 3 : servie, en préparation, ou servie puis réglée. */
    async function order(priceMinor: number, state: 'served' | 'preparing' | 'paid') {
      const res = await t.http.post('/api/v1/guest/orders').set((await currentGuest()).headers).send({ items: [{ menuItemId: prices[priceMinor], quantity: 1 }] }).expect(200);
      const id = res.body.request.id as string;
      await act(owner, id, 'prepare').expect(200);
      if (state !== 'preparing') await act(owner, id, 'resolve').expect(200);
      if (state === 'paid') await act(owner, id, 'settle').expect(200);
      return id;
    }
    return { owner, table, guest, order, act, currentGuest };
  }

  const settleTable = (owner: Account, table: Floor) => t.http.post(`${owner.base}/requests/settle-table`).set(owner.auth).send({ tableId: table.tableId });
  const occupation = async (owner: Account, table: Floor) =>
    (await t.http.get(`${owner.base}/tables/${table.tableId}/occupation`).set(owner.auth).expect(200)).body as {
      openSessions: number;
      occupiedSince: string | null;
      unpaidMinor: number | null;
      orders: { id: string; paidAt: string | null }[];
    };
  const guestRequests = async (guest: Guest) =>
    (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { id: string; paidAt: string | null }[];

  it('CA-026-01 — régler une commande servie : réglée, à son nom, hors des commandes à régler', async () => {
    const { owner, order, act } = await shop('Règlement simple');
    const id = await order(3000, 'served');
    const unpaidBefore = await t.http.get(`${owner.base}/requests`).query({ scope: 'unpaid' }).set(owner.auth).expect(200);
    expect(unpaidBefore.body.items.map((r: { id: string }) => r.id)).toEqual([id]);

    const res = await act(owner, id, 'settle').expect(200);
    expect(res.body.paidAt).not.toBeNull();
    expect(res.body.status).toBe('resolved');

    const detail = await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200);
    const paid = (detail.body.events as { type: string; actorName: string | null }[]).find((event) => event.type === 'request.paid');
    expect(paid?.actorName).toBe('Awa Koné');
    const unpaidAfter = await t.http.get(`${owner.base}/requests`).query({ scope: 'unpaid' }).set(owner.auth).expect(200);
    expect(unpaidAfter.body.items).toHaveLength(0);
  });

  it('CA-026-02 — seule une commande servie se règle, une seule fois', async () => {
    const { owner, guest, order, act } = await shop('Règlement refusé');
    const preparing = await order(1500, 'preparing');
    expect((await act(owner, preparing, 'settle').expect(409)).body.code).toBe('NOT_SERVED');
    const paid = await order(2000, 'paid');
    expect((await act(owner, paid, 'settle').expect(409)).body.code).toBe('ALREADY_PAID');
    const water = await t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: guest.typeIds[0] }).expect(200);
    expect((await act(owner, water.body.request.id, 'settle').expect(422)).body.code).toBe('NOT_AN_ORDER');
  });

  it('CA-026-03 — régler la table : seulement les commandes servies non réglées de l’occupation', async () => {
    const { owner, table, order } = await shop('Règlement de table');
    const a = await order(3000, 'served');
    const b = await order(4500, 'served');
    const alreadyPaid = await order(2000, 'paid');
    const preparing = await order(1500, 'preparing');
    expect((await occupation(owner, table)).unpaidMinor).toBe(7500);

    const res = await settleTable(owner, table).expect(200);
    expect(res.body).toEqual({ settled: 2, amountMinor: 7500 });

    const after = await occupation(owner, table);
    expect(after.unpaidMinor).toBe(0);
    const paidAt = new Map(after.orders.map((o) => [o.id, o.paidAt]));
    expect(paidAt.get(a)).not.toBeNull();
    expect(paidAt.get(b)).not.toBeNull();
    expect(paidAt.get(alreadyPaid)).not.toBeNull();
    expect(paidAt.get(preparing)).toBeNull();
    expect((await settleTable(owner, table).expect(409)).body.code).toBe('NOTHING_TO_SETTLE');
  });

  // Révisé par la spec 027, R4 : régler termine la session ; le client qui recommande en ouvre une nouvelle.
  it('CA-026-04 — après règlement, la table se libère et le client recommande dans une nouvelle session', async () => {
    const { owner, table, guest, order, currentGuest } = await shop('Règlement sans départ');
    await order(3000, 'served');
    await settleTable(owner, table).expect(200);
    expect((await occupation(owner, table)).occupiedSince).toBeNull();
    expect((await t.http.get('/api/v1/guest/session').set(guest.headers).expect(401)).body.code).toBe('TABLE_SESSION_SETTLED');
    const again = await order(2000, 'served');
    const after = await occupation(owner, table);
    expect(after.unpaidMinor).toBe(2000);
    expect((await guestRequests(await currentGuest())).find((r) => r.id === again)?.paidAt).toBeNull();
  });

  it('CA-026-05 — libérer avec un reste : les commandes non réglées restent à encaisser', async () => {
    const { owner, table, order } = await shop('Départ sans payer');
    await order(4500, 'served');
    await t.http.post(`${owner.base}/tables/${table.tableId}/sessions/close`).set(owner.auth).expect(200);
    const sales = await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'month' }).set(owner.auth).expect(200);
    expect(sales.body.outstanding).toEqual({ amountMinor: 4500, orders: 1, tables: 1 });
  });

  it('CA-026-06 — tableau de bord : total servi, encaissé et reste à encaisser', async () => {
    const { owner, order } = await shop('Caisse du mois');
    await order(3000, 'paid');
    await order(3000, 'paid');
    await order(4500, 'served');
    const sales = await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'month' }).set(owner.auth).expect(200);
    expect(sales.body.current).toMatchObject({ totalMinor: 10500, orders: 3, paidMinor: 6000, paidOrders: 2 });
    expect(sales.body.outstanding).toEqual({ amountMinor: 4500, orders: 1, tables: 1 });
  });

  it('CA-026-07 — le client voit ses commandes réglées', async () => {
    const { owner, guest, order, act } = await shop('Ma note réglée');
    const paid = await order(3000, 'served');
    const unpaid = await order(2000, 'served');
    await act(owner, paid, 'settle').expect(200);
    const mine = new Map((await guestRequests(guest)).map((r) => [r.id, r.paidAt]));
    expect(mine.get(paid)).not.toBeNull();
    expect(mine.get(unpaid)).toBeNull();
  });

  it('CA-026-08 — le serveur règle ; sans requests.handle, 403', async () => {
    const { owner, order, act } = await shop('Droits de règlement');
    const waiter = await addStaff(t, owner, 'waiter', 'Koffi');
    const id = await order(3000, 'served');
    await act(waiter, id, 'settle').expect(200);

    // Un gérant privé de requests.handle (permissions par employé, spec 010) ne peut pas régler.
    const manager = await addStaff(t, owner, 'manager', 'Nadia');
    const membership = await t.prisma.membership.findFirstOrThrow({ where: { userId: manager.userId } });
    await t.prisma.membership.update({ where: { id: membership.id }, data: { revokedPermissions: ['requests.handle'] } });
    const other = await order(2000, 'served');
    await act(manager, other, 'settle').expect(403);
  });
});
