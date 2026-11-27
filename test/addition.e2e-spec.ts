import { createHash } from 'node:crypto';
import { TasksService } from '../src/tasks/tasks.service';
import { UnpaidAlertsService } from '../src/resources/unpaid-alerts/unpaid-alerts';
import { Account, createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 028 — L'addition : une demande de facture, pas une commande.
 * Chaque test cite le critère couvert (specs/028-addition/spec.md).
 */
describe('Spec 028 — l’addition', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  interface BillView {
    id: string;
    status: string;
    type: { kind: string };
    bill: { dueMinor: number; pendingOrders: number } | null;
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200 }).expect(200);
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const item = await t.http.post(`${owner.base}/menu/items`).set(owner.auth).send({ categoryId: category.body.id, name: 'Garba', priceMinor: 1500 }).expect(201);
    const table = await createTable(t, owner, '2');
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({});

    async function order(guest: Guest, quantity: number, state: 'served' | 'preparing') {
      const res = await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId: item.body.id, quantity }] }).expect(200);
      const id = res.body.request.id as string;
      await act(id, 'prepare').expect(200);
      if (state === 'served') await act(id, 'resolve').expect(200);
      return id;
    }
    const billTypeId = async () => {
      const types = (await t.http.get(`${owner.base}/request-types`).set(owner.auth).expect(200)).body as { id: string; kind: string }[];
      return types.find((type) => type.kind === 'bill')!.id;
    };
    const billId = await billTypeId();
    const askBill = (guest: Guest) => t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: billId });
    const view = async (id: string) => (await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200)).body as BillView;
    return { owner, table, order, act, askBill, billTypeId, view };
  }

  const sessionOf = async (guest: Guest) => {
    const tokenHash = createHash('sha256').update(guest.token).digest('hex');
    return (await t.prisma.tableSession.findUniqueOrThrow({ where: { tokenHash } })).id;
  };
  const settleSession = (owner: Account, sessionId: string) => t.http.post(`${owner.base}/requests/settle-session`).set(owner.auth).send({ sessionId });

  it('CA-028-01 — demander l’addition crée une demande pour la session, montant dû en direct', async () => {
    const { order, askBill, view, table } = await shop('Demander l’addition');
    const guest = await openSession(t, table.code);
    await order(guest, 3, 'served');
    const res = await askBill(guest).expect(200);
    const bill = await view(res.body.request.id);
    expect(bill.type.kind).toBe('bill');
    expect(bill.bill).toEqual({ dueMinor: 4500, pendingOrders: 0 });
    const mine = (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { id: string }[];
    expect(mine.map((r) => r.id)).toContain(res.body.request.id);
  });

  it('CA-028-02 — rien à régler : la demande est refusée', async () => {
    const { order, askBill, table } = await shop('Rien à régler');
    const guest = await openSession(t, table.code);
    expect((await askBill(guest).expect(422)).body.code).toBe('NOTHING_TO_PAY');
    await order(guest, 1, 'preparing');
    expect((await askBill(guest).expect(422)).body.code).toBe('NOTHING_TO_PAY');
  });

  it('CA-028-03 — une seule demande ouverte par session', async () => {
    const { order, askBill, table } = await shop('Une seule addition');
    const guest = await openSession(t, table.code);
    await order(guest, 1, 'served');
    const first = await askBill(guest).expect(200);
    const second = await askBill(guest).expect(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.request.id).toBe(first.body.request.id);
  });

  it('CA-028-07 — ni « Accepter », ni « Commencer », ni « Terminer » ; le client ne l’annule pas', async () => {
    const { order, askBill, act, table } = await shop('Pas un circuit de service');
    const guest = await openSession(t, table.code);
    await order(guest, 1, 'served');
    const id = (await askBill(guest).expect(200)).body.request.id as string;
    for (const action of ['accept', 'start', 'resolve']) {
      expect((await act(id, action).expect(409)).body.code).toBe('BILL_SETTLE_ONLY');
    }
    const cancel = await t.http.post(`/api/v1/guest/requests/${id}/cancel`).set(guest.headers).send({});
    expect(cancel.status).toBe(409);
  });

  it('CA-028-08 et 09 — régler le client clôt la demande ; un second règlement ne règle rien de plus', async () => {
    const { owner, order, askBill, view, table } = await shop('Régler l’addition');
    const guest = await openSession(t, table.code);
    await order(guest, 3, 'served');
    const id = (await askBill(guest).expect(200)).body.request.id as string;
    const sessionId = await sessionOf(guest);
    expect((await settleSession(owner, sessionId).expect(200)).body).toEqual({ settled: 1, amountMinor: 4500 });
    expect((await view(id)).status).toBe('resolved');
    expect((await settleSession(owner, sessionId).expect(409)).body.code).toBe('NOTHING_TO_SETTLE');
    expect((await t.prisma.tableSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('settled');
    const event = await t.prisma.serviceRequestEvent.findFirstOrThrow({ where: { requestId: id, type: 'request.resolved' } });
    expect(event.payload).toEqual({ billClosedBy: 'settled' });
  });

  it('CA-028-08 — « Glisser pour régler » sur la demande d’addition règle son client', async () => {
    const { order, askBill, act, view, table } = await shop('Régler depuis la demande');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    await order(a, 2, 'served');
    const fromB = await order(b, 1, 'served');
    const id = (await askBill(a).expect(200)).body.request.id as string;
    const settled = await act(id, 'settle-bill').expect(200);
    expect(settled.body.status).toBe('resolved');
    expect((await view(fromB)).status).toBe('resolved');
    const other = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id: fromB } });
    expect(other.paidAt).toBeNull();
    expect((await act(id, 'settle-bill').expect(409)).body.code).toBe('NOTHING_TO_SETTLE');
  });

  it('CA-028-10 — « Régler la table » clôt toutes les demandes d’addition', async () => {
    const { owner, order, askBill, view, table } = await shop('Régler la table');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    await order(a, 1, 'served');
    await order(b, 2, 'served');
    const billA = (await askBill(a).expect(200)).body.request.id as string;
    const billB = (await askBill(b).expect(200)).body.request.id as string;
    await t.http.post(`${owner.base}/requests/settle-table`).set(owner.auth).send({ tableId: table.tableId }).expect(200);
    expect((await view(billA)).status).toBe('resolved');
    expect((await view(billB)).status).toBe('resolved');
  });

  it('CA-028-11 — libération, expiration et « Parti sans payer » closent la demande, raison au journal', async () => {
    const { owner, order, askBill, view, table } = await shop('Clôture sans règlement');
    const reason = async (id: string) =>
      (await t.prisma.serviceRequestEvent.findFirstOrThrow({ where: { requestId: id, type: 'request.cancelled' } })).payload;

    const released = await openSession(t, table.code);
    await order(released, 1, 'served');
    const r1 = (await askBill(released).expect(200)).body.request.id as string;
    await t.http.post(`${owner.base}/tables/${table.tableId}/sessions/close`).set(owner.auth).send({}).expect(200);
    expect((await view(r1)).status).toBe('cancelled');
    expect(await reason(r1)).toEqual({ billClosedBy: 'released' });

    const expired = await openSession(t, table.code);
    await order(expired, 1, 'served');
    const r2 = (await askBill(expired).expect(200)).body.request.id as string;
    await t.prisma.tableSession.update({ where: { id: await sessionOf(expired) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await t.app.get(TasksService).expireSessionsNow();
    expect((await view(r2)).status).toBe('cancelled');
    expect(await reason(r2)).toEqual({ billClosedBy: 'expired' });

    const walked = await openSession(t, table.code);
    await order(walked, 1, 'served');
    const r3 = (await askBill(walked).expect(200)).body.request.id as string;
    await t.prisma.tableSession.update({ where: { id: await sessionOf(walked) }, data: { lastActivityAt: new Date(Date.now() - 60 * 60_000) } });
    await t.app.get(UnpaidAlertsService).sweep();
    // Spec 027, R10 : les sessions libérée et expirée ont aussi levé une alerte ; on traite celle du client parti.
    const walkedId = await sessionOf(walked);
    const alert = ((await t.http.get(`${owner.base}/unpaid-alerts`).set(owner.auth).expect(200)).body as { id: string; sessionId: string }[]).find(
      (candidate) => candidate.sessionId === walkedId,
    )!;
    await t.http.post(`${owner.base}/unpaid-alerts/${alert.id}/resolve`).set(owner.auth).send({ resolution: 'walked_out' }).expect(200);
    expect((await view(r3)).status).toBe('cancelled');
    expect(await reason(r3)).toEqual({ billClosedBy: 'walked_out' });
  });

  it('CA-028-12 — le montant suit les commandes servies après la demande', async () => {
    const { order, askBill, view, act, table } = await shop('Montant en direct');
    const guest = await openSession(t, table.code);
    await order(guest, 3, 'served');
    const id = (await askBill(guest).expect(200)).body.request.id as string;
    const coffee = await order(guest, 1, 'preparing');
    expect((await view(id)).bill).toEqual({ dueMinor: 4500, pendingOrders: 1 });
    await act(coffee, 'resolve').expect(200);
    expect((await view(id)).bill).toEqual({ dueMinor: 6000, pendingOrders: 0 });
  });

  it('CA-028-13 — la demande d’addition se renomme ou se masque, ne se supprime pas', async () => {
    const { owner, billTypeId } = await shop('Addition permanente');
    const id = await billTypeId();
    expect((await t.http.delete(`${owner.base}/request-types/${id}`).set(owner.auth).expect(409)).body.code).toBe('BILL_TYPE_REQUIRED');
    await t.http.patch(`${owner.base}/request-types/${id}`).set(owner.auth).send({ label: 'La note', isActive: false }).expect(200);
  });
});
