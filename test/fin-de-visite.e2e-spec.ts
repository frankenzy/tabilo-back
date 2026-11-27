import { createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/** Spec 047 — fin de visite : libérer la table. Chaque test cite le critère couvert. */
describe('Spec 047 — fin de visite', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201)).body.id as string;
    const garba = (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: 'Garba', priceMinor: 2500 }).expect(201)).body.id as string;
    const table = await createTable(t, owner, '2');
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);
    /** Commande servie et réglée : la session se termine (spec 027, R4). */
    const settle = async (guest: Guest) => {
      const id = (await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId: garba, quantity: 1 }] }).expect(200)).body.request.id as string;
      await act(id, 'prepare');
      await act(id, 'resolve');
      await act(id, 'settle');
    };
    const leave = (guest: Guest, status = 200) => t.http.post('/api/v1/guest/session/leave').set(guest.headers).send({}).expect(status);
    const events = async () =>
      (await t.prisma.outboxEvent.findMany({ where: { establishmentId: owner.establishmentId, type: 'session.left' } })).map((event) => event.payload as { tableLabel: string; tableFree: boolean });
    return { owner, table, settle, leave, events };
  }

  it('CA-047-03 et CA-047-05 — une session réglée libère la table ; le personnel est prévenu une fois, table libre', async () => {
    const { table, settle, leave, events, owner } = await shop('Fin de visite libre');
    const guest = await openSession(t, table.code);
    await settle(guest);
    expect((await leave(guest)).body).toEqual({ left: true, tableFree: true });
    expect(await events()).toEqual([expect.objectContaining({ tableLabel: '2', tableFree: true })]);
    // Une seconde demande ne renvoie pas d'événement.
    await leave(guest);
    expect(await events()).toHaveLength(1);
    expect(await t.prisma.auditLog.count({ where: { establishmentId: owner.establishmentId, action: 'session.left' } })).toBe(1);
  });

  it('CA-047-05 — un autre téléphone encore à table : pas « table libre »', async () => {
    const { table, settle, leave, events } = await shop('Fin de visite occupée');
    const other = await openSession(t, table.code);
    const guest = await openSession(t, table.code);
    await settle(guest);
    expect((await leave(guest)).body.tableFree).toBe(false);
    expect((await events())[0]).toMatchObject({ tableFree: false });
    // L'autre session reste ouverte : la spec 047 ne la touche pas.
    await t.http.get('/api/v1/guest/session').set(other.headers).expect(200);
  });

  it('CA-047-04 — une session encore ouverte ne libère pas la table', async () => {
    const { table, leave } = await shop('Fin de visite ouverte');
    const guest = await openSession(t, table.code);
    expect((await leave(guest, 409)).body.code).toBe('SESSION_NOT_SETTLED');
  });
});
