import { createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

/** Spec 048 — le plus récent d'abord (LIFO). Chaque test cite le critère couvert. */
describe('Spec 048 — ordre LIFO', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it('CA-048-03 — demandes actives et clients d’une table : le plus récent d’abord', async () => {
    const owner = await registerTenant(t, 'Ordre LIFO');
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201)).body.id as string;
    const garba = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Garba', priceMinor: 2500 }).expect(201)).body.id as string;
    const table = await createTable(t, owner, '4');

    const first = await openSession(t, table.code);
    const second = await openSession(t, table.code);
    const order = async (headers: { 'x-table-session': string }) =>
      (await t.http.post('/api/v1/guest/orders').set(headers).send({ items: [{ menuItemId: garba, quantity: 1 }] }).expect(200)).body.request.id as string;
    const a = await order(first.headers);
    const b = await order(second.headers);
    const c = await order(first.headers);

    const active = (await t.http.get(`${owner.base}/requests`).query({ scope: 'active', pageSize: 100 }).set(owner.auth).expect(200)).body.items as { id: string }[];
    expect(active.map((row) => row.id)).toEqual([c, b, a]);

    const occupation = (await t.http.get(`${owner.base}/tables/${table.tableId}/occupation`).set(owner.auth).expect(200)).body as {
      orders: { id: string }[];
      sessions: { marker: number }[];
    };
    expect(occupation.orders.map((row) => row.id)).toEqual([c, b, a]);
    // Le second téléphone est arrivé en dernier : il passe en premier.
    const markers = await t.prisma.tableSession.findMany({ where: { tableId: table.tableId }, orderBy: { openedAt: 'desc' }, select: { markerIndex: true } });
    expect(occupation.sessions.map((session) => session.marker)).toEqual(markers.map((row) => row.markerIndex));
  });
});
