import { createHash } from 'node:crypto';
import { TasksService } from '../src/tasks/tasks.service';
import { UnpaidAlertsService } from '../src/resources/unpaid-alerts/unpaid-alerts';
import { Account, addStaff, createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 030 — Façon de servir réglable par établissement.
 * Chaque test cite le critère couvert (specs/030-facon-de-servir/spec.md).
 */
describe('Spec 030 — façon de servir', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  type Mode = 'serve_then_pay' | 'pay_anytime' | 'pay_first';

  async function shop(name: string, settings: { serviceMode?: Mode; autoStartOrders?: boolean } = {}) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0, ...settings }).expect(200);
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const item = await t.http.post(`${owner.base}/menu/items`).set(owner.auth).send({ categoryId: category.body.id, name: 'Garba', priceMinor: 3500 }).expect(201);
    const table = await createTable(t, owner, '4');
    const guest = await openSession(t, table.code);
    const act = (account: Account, id: string, action: string) => t.http.post(`${account.base}/requests/${id}/${action}`).set(account.auth).send({});
    const order = async (who: Guest = guest) =>
      (await t.http.post('/api/v1/guest/orders').set(who.headers).send({ items: [{ menuItemId: item.body.id, quantity: 1 }] }).expect(200)).body.request as {
        id: string;
        status: string;
        totalMinor: number;
      };
    const types = (await t.http.get(`${owner.base}/request-types`).set(owner.auth).expect(200)).body as { id: string; kind: string }[];
    const billId = types.find((type) => type.kind === 'bill')!.id;
    const askBill = (who: Guest = guest) => t.http.post('/api/v1/guest/requests').set(who.headers).send({ requestTypeId: billId });
    const view = async (id: string) => (await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200)).body;
    const setMode = (settings: { serviceMode?: Mode; autoStartOrders?: boolean }) => t.http.patch(owner.base).set(owner.auth).send(settings);
    return { owner, table, guest, act, order, askBill, view, setMode };
  }

  const sessionOf = async (guest: Guest) => {
    const tokenHash = createHash('sha256').update(guest.token).digest('hex');
    return (await t.prisma.tableSession.findUniqueOrThrow({ where: { tokenHash } })).id;
  };
  const guestView = async (guest: Guest, id: string) =>
    ((await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { id: string; status: string; paidAt: string | null }[]).find((r) => r.id === id)!;

  it('CA-030-01 — par défaut, servir puis régler, et une commande non servie ne se règle pas', async () => {
    const { owner, order, act } = await shop('Façon par défaut');
    const settings = await t.http.get(owner.base).set(owner.auth).expect(200);
    expect(settings.body.serviceMode).toBe('serve_then_pay');
    expect(settings.body.autoStartOrders).toBe(false);
    const created = await order();
    expect(created.status).toBe('pending');
    await act(owner, created.id, 'prepare').expect(200);
    expect((await act(owner, created.id, 'settle').expect(409)).body.code).toBe('NOT_SERVED');
  });

  it('CA-030-02 — le gérant change la façon de servir, journalisée ; un serveur est refusé', async () => {
    const { owner, setMode } = await shop('Façon modifiée');
    const res = await setMode({ serviceMode: 'pay_first' }).expect(200);
    expect(res.body.serviceMode).toBe('pay_first');
    const logs = await t.prisma.auditLog.findMany({ where: { establishmentId: owner.establishmentId, action: 'establishment.updated' } });
    expect(logs.some((log) => JSON.stringify(log.metadata).includes('serviceMode'))).toBe(true);
    const waiter = await addStaff(t, owner, 'waiter');
    await t.http.patch(waiter.base).set(waiter.auth).send({ serviceMode: 'pay_anytime' }).expect(403);
    await setMode({ serviceMode: 'n_importe_quoi' as Mode }).expect(400);
  });

  it('CA-030-03 — une commande garde la façon de servir de son envoi', async () => {
    const { owner, order, view, setMode, act } = await shop('Façon figée', { serviceMode: 'pay_first' });
    const created = await order();
    await setMode({ serviceMode: 'serve_then_pay' }).expect(200);
    expect((await view(created.id)).status).toBe('awaiting_payment');
    await act(owner, created.id, 'settle').expect(200);
    expect((await view(created.id)).status).toBe('in_progress');
  });

  it('CA-030-04 — caisse d’abord : la commande attend l’encaissement, hors des commandes à préparer', async () => {
    const { owner, guest, order, act } = await shop('Caisse attente', { serviceMode: 'pay_first' });
    const created = await order();
    expect(created.status).toBe('awaiting_payment');
    expect(created.totalMinor).toBe(3500);
    expect((await guestView(guest, created.id)).status).toBe('awaiting_payment');
    const unpaid = await t.http.get(`${owner.base}/requests`).query({ scope: 'unpaid' }).set(owner.auth).expect(200);
    expect(unpaid.body.items.map((r: { id: string }) => r.id)).toEqual([created.id]);
    expect((await act(owner, created.id, 'prepare').expect(409)).body.code).toBe('ALREADY_TAKEN');
  });

  it('CA-030-05 — caisse d’abord : « Encaissé » règle et lance la préparation', async () => {
    const { owner, guest, order, act, view } = await shop('Caisse encaisse', { serviceMode: 'pay_first' });
    const waiter = await addStaff(t, owner, 'waiter', 'Koffi');
    const created = await order();
    const res = await act(waiter, created.id, 'settle').expect(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.paidAt).not.toBeNull();
    expect(res.body.assignee).toBeNull();
    const seen = await guestView(guest, created.id);
    expect(seen.status).toBe('in_progress');
    expect(seen.paidAt).not.toBeNull();
    const events = (await view(created.id)).events as { type: string; actorName: string | null }[];
    expect(events.find((event) => event.type === 'request.paid')?.actorName).toContain('Koffi');
    // Partie en préparation sans personne affectée : n'importe quel serveur la sert.
    await act(waiter, created.id, 'resolve').expect(200);
    expect((await act(owner, created.id, 'settle').expect(409)).body.code).toBe('ALREADY_PAID');
  });

  it('CA-030-06 — caisse d’abord : annulable avant l’encaissement seulement', async () => {
    const { owner, guest, order, act } = await shop('Caisse annule', { serviceMode: 'pay_first' });
    const first = await order();
    await t.http.post(`/api/v1/guest/requests/${first.id}/cancel`).set(guest.headers).send({}).expect(200);
    const second = await order();
    await act(owner, second.id, 'settle').expect(200);
    expect((await t.http.post(`/api/v1/guest/requests/${second.id}/cancel`).set(guest.headers).send({}).expect(409)).body.code).toBe('PAID_CANNOT_CANCEL');
  });

  it('CA-030-07 — caisse d’abord : ni addition ni alerte de départ sans payer', async () => {
    const { owner, guest, order, askBill, act } = await shop('Caisse sans addition', { serviceMode: 'pay_first' });
    // Commande encaissée, encore en préparation : la session est ouverte, l'addition est refusée.
    const created = await order();
    await act(owner, created.id, 'settle').expect(200);
    expect((await askBill().expect(422)).body.code).toBe('BILL_DISABLED');
    const context = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
    expect(context.body.serviceMode).toBe('pay_first');
    // Une commande encore à encaisser, puis une longue inactivité : aucune alerte.
    await order();
    await act(owner, created.id, 'resolve').expect(200);
    await t.prisma.tableSession.update({ where: { id: await sessionOf(guest) }, data: { lastActivityAt: new Date(Date.now() - 60 * 60_000) } });
    await t.app.get(UnpaidAlertsService).sweep();
    expect(await t.prisma.unpaidAlert.count({ where: { establishmentId: owner.establishmentId } })).toBe(0);
  });

  it('CA-030-08 — caisse d’abord : une commande jamais encaissée est annulée à l’expiration', async () => {
    const { owner, guest, order, view } = await shop('Caisse abandon', { serviceMode: 'pay_first' });
    const created = await order();
    await t.prisma.tableSession.update({ where: { id: await sessionOf(guest) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await t.app.get(TasksService).expireSessionsNow();
    expect((await view(created.id)).status).toBe('cancelled');
    const unpaid = await t.http.get(`${owner.base}/requests`).query({ scope: 'unpaid' }).set(owner.auth).expect(200);
    expect(unpaid.body.items).toHaveLength(0);
  });

  it('CA-030-09 — régler quand on veut : l’addition avant le service compte la commande', async () => {
    const { owner, order, askBill, act, view } = await shop('Restaurant addition', { serviceMode: 'pay_anytime' });
    const created = await order();
    await act(owner, created.id, 'prepare').expect(200);
    const bill = await askBill().expect(200);
    expect((await view(bill.body.request.id)).bill).toEqual({ dueMinor: 3500, pendingOrders: 0 });
  });

  it('CA-030-10 — régler quand on veut : réglée avant d’être servie, la session se termine au service', async () => {
    const { owner, guest, order, act } = await shop('Restaurant règle', { serviceMode: 'pay_anytime' });
    const created = await order();
    await act(owner, created.id, 'prepare').expect(200);
    const paid = await act(owner, created.id, 'settle').expect(200);
    expect(paid.body.status).toBe('in_progress');
    expect(paid.body.paidAt).not.toBeNull();
    const sessionId = await sessionOf(guest);
    expect((await t.prisma.tableSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('open');
    await act(owner, created.id, 'resolve').expect(200);
    expect((await t.prisma.tableSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('settled');
  });

  it('CA-030-11 — une commande réglée ne s’annule plus', async () => {
    const { owner, guest, order, act } = await shop('Réglée non annulable', { serviceMode: 'pay_anytime' });
    const pending = await order();
    await act(owner, pending.id, 'settle').expect(200);
    expect((await t.http.post(`/api/v1/guest/requests/${pending.id}/cancel`).set(guest.headers).send({}).expect(409)).body.code).toBe('PAID_CANNOT_CANCEL');
    expect((await act(owner, pending.id, 'cancel').expect(409)).body.code).toBe('PAID_CANNOT_CANCEL');
  });

  it('CA-030-12 — lancer la préparation tout de suite : en préparation, plus annulable par le client', async () => {
    const { owner, guest, order, act } = await shop('Préparation directe', { autoStartOrders: true });
    const created = await order();
    expect(created.status).toBe('in_progress');
    expect((await t.http.post(`/api/v1/guest/requests/${created.id}/cancel`).set(guest.headers).send({}).expect(409)).body.code).toBe('REQUEST_ALREADY_HANDLED');
    const waiter = await addStaff(t, owner, 'waiter');
    await act(waiter, created.id, 'resolve').expect(200);
  });

  it('CA-030-13 — en caisse d’abord, « lancer la préparation tout de suite » est sans effet', async () => {
    const { order } = await shop('Caisse et préparation', { serviceMode: 'pay_first', autoStartOrders: true });
    expect((await order()).status).toBe('awaiting_payment');
  });
});
