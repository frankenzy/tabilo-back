import { io, Socket } from 'socket.io-client';
import { Account, addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 007 — Écran « Commandes » : préparer et servir les commandes.
 * Chaque test cite le critère d'acceptation qu'il couvre (specs/007-ecran-commandes/spec.md).
 */
describe('Spec 007 — écran Commandes', () => {
  let t: TestApp;
  let owner: Account;
  let koffi: Account;
  let fatou: Account;
  let itemId: string;
  let code: string;

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'Maquis des Commandes');
    koffi = await addStaff(t, owner, 'waiter', 'Koffi');
    fatou = await addStaff(t, owner, 'waiter', 'Fatou');
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const item = await t.http
      .post(`${owner.base}/menu/items`)
      .set(owner.auth)
      .send({ categoryId: category.body.id, name: 'Garba', priceMinor: 1500 })
      .expect(201);
    itemId = item.body.id as string;
    code = (await createTable(t, owner, 'C1')).code;
  });
  afterAll(() => t.close());

  const kitchen = (separateKitchen: boolean) =>
    t.http.patch(owner.base).set(owner.auth).send({ separateKitchen }).expect(200);

  async function order(): Promise<string> {
    const guest = await openSession(t, code);
    const res = await t.http
      .post('/api/v1/guest/orders')
      .set(guest.headers)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }] })
      .expect(200);
    return res.body.request.id as string;
  }

  const act = (who: Account, id: string, action: string) => t.http.post(`${who.base}/requests/${id}/${action}`).set(who.auth).send({});

  it('CA-007-07 — l’étape « Prête » est désactivée pour un nouvel établissement', async () => {
    const res = await t.http.get(owner.base).set(owner.auth).expect(200);
    expect(res.body.separateKitchen).toBe(false);
    const id = await order();
    await act(koffi, id, 'prepare').expect(200);
    const ready = await act(koffi, id, 'ready').expect(409);
    expect(ready.body.code).toBe('READY_DISABLED');
    await act(koffi, id, 'resolve').expect(200);
  });

  it('CA-007-04 — maquis : « Préparer » accepte et démarre en un geste, puis « Servie » termine', async () => {
    const id = await order();
    const prepared = await act(koffi, id, 'prepare').expect(200);
    expect(prepared.body.status).toBe('in_progress');
    expect(prepared.body.assignee.id).toBe(koffi.userId);
    expect(prepared.body.acceptedAt).not.toBeNull();
    const served = await act(koffi, id, 'resolve').expect(200);
    expect(served.body.status).toBe('resolved');
    const events = await t.prisma.serviceRequestEvent.findMany({ where: { requestId: id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['request.created', 'request.assigned', 'request.accepted', 'request.started', 'request.resolved']);
  });

  it('CA-007-08 — un serveur ne peut pas modifier le réglage « Cuisine séparée »', async () => {
    await t.http.patch(koffi.base).set(koffi.auth).send({ separateKitchen: true }).expect(403);
  });

  it('CA-007-05 — cuisine séparée : « Prête » prévient le personnel, un autre serveur sert', async () => {
    await kitchen(true);
    const socket: Socket = io(t.url, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: fatou.token, establishmentId: fatou.establishmentId },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    try {
      const id = await order();
      await act(koffi, id, 'prepare').expect(200);
      const received = new Promise<{ type: string; request: { id: string; status: string } }>((resolve) => {
        socket.on('request.changed', (event: { type: string; request: { id: string; status: string } }) => {
          if (event.type === 'request.ready' && event.request.id === id) resolve(event);
        });
      });
      const ready = await act(koffi, id, 'ready').expect(200);
      expect(ready.body.status).toBe('ready');
      expect(ready.body.readyAt).toBeDefined();
      expect((await received).request.status).toBe('ready');
      // Fatou n'a pas préparé la commande, mais c'est elle qui la sert.
      await act(fatou, id, 'resolve').expect(200);
    } finally {
      socket.close();
      await kitchen(false);
    }
  });

  it('CA-007-05 — le client voit « En préparation » tant que la commande n’est pas servie (Q2)', async () => {
    await kitchen(true);
    try {
      const guest = await openSession(t, code);
      const placed = await t.http
        .post('/api/v1/guest/orders')
        .set(guest.headers)
        .send({ items: [{ menuItemId: itemId, quantity: 1 }] })
        .expect(200);
      const id = placed.body.request.id as string;
      await act(koffi, id, 'prepare').expect(200);
      await act(koffi, id, 'ready').expect(200);
      const mine = await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200);
      expect((mine.body as { id: string; status: string }[]).find((r) => r.id === id)!.status).toBe('in_progress');
      await act(koffi, id, 'resolve').expect(200);
    } finally {
      await kitchen(false);
    }
  });

  it('CA-007-09 — deux tablettes : la seconde voit « Déjà prise par Koffi »', async () => {
    const id = await order();
    await act(koffi, id, 'prepare').expect(200);
    const second = await act(fatou, id, 'prepare').expect(409);
    expect(second.body.code).toBe('ALREADY_TAKEN');
    expect(second.body.message).toBe('Déjà prise par Koffi.');
    const events = await t.prisma.serviceRequestEvent.count({ where: { requestId: id, type: 'request.started' } });
    expect(events).toBe(1);
    await act(koffi, id, 'resolve').expect(200);
  });

  it('CA-007-11 — on annule une commande à préparer, pas une commande lancée', async () => {
    const waiting = await order();
    await act(owner, waiting, 'cancel').expect(200);
    const started = await order();
    await act(koffi, started, 'prepare').expect(200);
    const refused = await act(owner, started, 'cancel').expect(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    await act(koffi, started, 'resolve').expect(200);
  });

  it('CA-007-02 — « Préparer » refuse une demande qui n’est pas une commande', async () => {
    const guest = await openSession(t, code);
    const res = await t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: guest.typeIds[0] }).expect(200);
    const refused = await act(koffi, res.body.request.id as string, 'prepare').expect(422);
    expect(refused.body.code).toBe('NOT_AN_ORDER');
  });

  it('CA-012-05 — « Souvent pris avec » part désactivé, se règle par la gérante, jamais par un serveur', async () => {
    expect((await t.http.get(owner.base).set(owner.auth).expect(200)).body.pairingsEnabled).toBe(false);
    const before = await openSession(t, code);
    const context = await t.http.get('/api/v1/guest/session').set(before.headers).expect(200);
    expect(context.body.pairingsEnabled).toBe(false);

    await t.http.patch(koffi.base).set(koffi.auth).send({ pairingsEnabled: true }).expect(403);
    await t.http.patch(owner.base).set(owner.auth).send({ pairingsEnabled: true }).expect(200);
    const after = await openSession(t, code);
    const enabled = await t.http.post('/api/v1/guest/sessions').send({ code }).expect(201);
    expect(enabled.body.pairingsEnabled).toBe(true);
    expect((await t.http.get('/api/v1/guest/session').set(after.headers).expect(200)).body.pairingsEnabled).toBe(true);
    await t.http.patch(owner.base).set(owner.auth).send({ pairingsEnabled: false }).expect(200);
  });
});
