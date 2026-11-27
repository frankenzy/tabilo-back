import { addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 033 — Les bonus : prix promotionnel et geste « Offert ».
 * Chaque test cite le critère couvert (specs/033-bonus-promotions-offerts/spec.md).
 */
describe('Spec 033 — bonus', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  interface Line {
    id: string;
    name: string;
    unitPriceMinor: number;
    listPriceMinor: number | null;
    offeredAt: string | null;
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Grillades' }).expect(201)).body.id as string;
    const poulet = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Poulet braisé', priceMinor: 3500 }).expect(201)).body as { id: string };
    const coca = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Coca', priceMinor: 500 }).expect(201)).body as { id: string };
    const table = await createTable(t, owner, '4');
    let guest = await openSession(t, table.code);
    const order = async (lines: { menuItemId: string; quantity: number }[]) => {
      // Spec 027, R4 : une session réglée est terminée ; le client suivant en ouvre une nouvelle.
      if ((await t.http.get('/api/v1/guest/session').set(guest.headers)).status === 401) guest = await openSession(t, table.code);
      return (await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: lines }).expect(200)).body.request as { id: string; totalMinor: number; items: Line[] };
    };
    const view = async (id: string) => (await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200)).body as { totalMinor: number; items: Line[] };
    const offer = (who: typeof owner, id: string, itemId: string) => t.http.post(`${who.base}/requests/${id}/items/${itemId}/offer`).set(who.auth).send({});
    const unoffer = (who: typeof owner, id: string, itemId: string) => t.http.delete(`${who.base}/requests/${id}/items/${itemId}/offer`).set(who.auth);
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({});
    return { owner, menu, poulet, coca, guest: () => guest, order, view, offer, unoffer, act };
  }

  it('CA-033-01 — mettre en promotion ; un prix promo supérieur ou égal est refusé', async () => {
    const { owner, menu, poulet, guest } = await shop('Bonus promo');
    const res = await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ promoPriceMinor: 3000 }).expect(200);
    expect(res.body).toMatchObject({ priceMinor: 3500, promoPriceMinor: 3000 });
    const seen = ((await t.http.get('/api/v1/guest/session').set(guest().headers).expect(200)).body.menu as { items: { id: string; promoPriceMinor: number | null }[] }[])
      .flatMap((category) => category.items)
      .find((item) => item.id === poulet.id)!;
    expect(seen.promoPriceMinor).toBe(3000);
    expect((await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ promoPriceMinor: 3500 }).expect(422)).body.code).toBe('PROMO_PRICE_INVALID');
    // Baisser le prix sous la promotion en cours est refusé aussi.
    expect((await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ priceMinor: 2500 }).expect(422)).body.code).toBe('PROMO_PRICE_INVALID');
  });

  it('CA-033-02 — prix promo figé à la commande ; la fin de promotion vaut pour les nouvelles commandes', async () => {
    const { owner, menu, poulet, order } = await shop('Bonus figé');
    await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ promoPriceMinor: 3000 }).expect(200);
    const during = await order([{ menuItemId: poulet.id, quantity: 1 }]);
    expect(during.totalMinor).toBe(3000);
    expect(during.items[0]).toMatchObject({ unitPriceMinor: 3000, listPriceMinor: 3500 });
    await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ promoPriceMinor: null }).expect(200);
    const after = await order([{ menuItemId: poulet.id, quantity: 1 }]);
    expect(after.totalMinor).toBe(3500);
    expect(after.items[0]).toMatchObject({ unitPriceMinor: 3500, listPriceMinor: null });
  });

  it('CA-033-03 — offrir une ligne : l’addition baisse, la ligne reste visible et offerte', async () => {
    const { owner, poulet, coca, guest, order, view, offer, unoffer } = await shop('Bonus offert');
    const created = await order([{ menuItemId: poulet.id, quantity: 1 }, { menuItemId: coca.id, quantity: 1 }]);
    expect(created.totalMinor).toBe(4000);
    const cocaLine = created.items.find((line) => line.name === 'Coca')!;
    const res = await offer(owner, created.id, cocaLine.id).expect(200);
    expect(res.body.totalMinor).toBe(3500);
    expect((res.body.items as Line[]).find((line) => line.id === cocaLine.id)!.offeredAt).not.toBeNull();
    const seen = ((await t.http.get('/api/v1/guest/requests').set(guest().headers).expect(200)).body as { id: string; totalMinor: number; items: Line[] }[]).find((r) => r.id === created.id)!;
    expect(seen.totalMinor).toBe(3500);
    expect(seen.items.find((line) => line.name === 'Coca')!.offeredAt).not.toBeNull();
    expect((await offer(owner, created.id, cocaLine.id).expect(409)).body.code).toBe('ALREADY_OFFERED');
    // R5 : retirer le cadeau tant que la commande n'est pas réglée.
    await unoffer(owner, created.id, cocaLine.id).expect(200);
    expect((await view(created.id)).totalMinor).toBe(4000);
  });

  it('CA-033-04 — un serveur sans orders.offer est refusé ; le gérant peut offrir', async () => {
    const { owner, coca, order, offer } = await shop('Bonus droits');
    const created = await order([{ menuItemId: coca.id, quantity: 1 }]);
    const waiter = await addStaff(t, owner, 'waiter');
    await offer(waiter, created.id, created.items[0].id).expect(403);
    const manager = await addStaff(t, owner, 'manager', 'Awa');
    await offer(manager, created.id, created.items[0].id).expect(200);
  });

  it('CA-033-05 — pas d’offert sur une commande réglée ou annulée', async () => {
    const { owner, coca, guest, order, offer, unoffer, act } = await shop('Bonus fermé');
    const paid = await order([{ menuItemId: coca.id, quantity: 1 }]);
    await act(paid.id, 'prepare').expect(200);
    await act(paid.id, 'resolve').expect(200);
    await act(paid.id, 'settle').expect(200);
    expect((await offer(owner, paid.id, paid.items[0].id).expect(409)).body.code).toBe('ORDER_CLOSED');
    expect((await unoffer(owner, paid.id, paid.items[0].id).expect(409)).body.code).toBe('ORDER_CLOSED');
    const cancelled = await order([{ menuItemId: coca.id, quantity: 1 }]);
    await t.http.post(`/api/v1/guest/requests/${cancelled.id}/cancel`).set(guest().headers).send({}).expect(200);
    expect((await offer(owner, cancelled.id, cancelled.items[0].id).expect(409)).body.code).toBe('ORDER_CLOSED');
  });

  it('CA-033-06 — ventes : offert et remises à part, hors du total ; « Offert » au journal', async () => {
    const { owner, menu, poulet, coca, order, offer, act } = await shop('Bonus ventes');
    await t.http.patch(`${menu}/items/${poulet.id}`).set(owner.auth).send({ promoPriceMinor: 3000 }).expect(200);
    const created = await order([{ menuItemId: poulet.id, quantity: 1 }, { menuItemId: coca.id, quantity: 1 }]);
    await offer(owner, created.id, created.items.find((line) => line.name === 'Coca')!.id).expect(200);
    await act(created.id, 'prepare').expect(200);
    await act(created.id, 'resolve').expect(200);
    const sales = (await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'month' }).set(owner.auth).expect(200)).body;
    expect(sales.current).toMatchObject({ totalMinor: 3000, offeredMinor: 500, discountMinor: 500 });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { establishmentId: owner.establishmentId, action: 'order_line.offered' } });
    expect(log.metadata).toMatchObject({ table: '4', item: 'Coca', amountMinor: 500 });
  });
});
