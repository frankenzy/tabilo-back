import { UnpaidAlertsService } from '../src/resources/unpaid-alerts/unpaid-alerts';
import { Account, addStaff, createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 027 — Une session par client : repère, règlement, zone et alerte de départ sans payer.
 * Chaque test cite le critère couvert (specs/027-session-par-client/spec.md).
 */
describe('Spec 027 — une session par client', () => {
  let t: TestApp;
  let alerts: UnpaidAlertsService;

  beforeAll(async () => {
    t = await startApp();
    alerts = t.app.get(UnpaidAlertsService);
  });
  afterAll(() => t.close());

  // Centre de zone (Plateau, Abidjan) et position à `meters` au nord (1° de latitude ≈ 111 195 m).
  const CENTER = { latitude: 5.3197, longitude: -4.0167 };
  const north = (meters: number, accuracyM = 20) => ({ latitude: CENTER.latitude + meters / 111_195, longitude: CENTER.longitude, accuracyM });

  interface RequestBody {
    id: string;
    marker: number | null;
    zone: { status: string; distanceM: number | null } | null;
    paidAt: string | null;
    writtenOffAt: string | null;
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200 }).expect(200);
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const item = await t.http.post(`${owner.base}/menu/items`).set(owner.auth).send({ categoryId: category.body.id, name: 'Garba', priceMinor: 1500 }).expect(201);
    const table = await createTable(t, owner, '2');
    const act = (account: Account, id: string, action: string) => t.http.post(`${account.base}/requests/${id}/${action}`).set(account.auth).send({});

    /** Commande d'un client : `quantity` Garba à 1 500 F, servie ou en préparation. */
    async function order(guest: Guest, quantity: number, state: 'served' | 'preparing' | 'pending', extra: Record<string, unknown> = {}) {
      const res = await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId: item.body.id, quantity }], ...extra }).expect(200);
      const id = res.body.request.id as string;
      if (state !== 'pending') await act(owner, id, 'prepare').expect(200);
      if (state === 'served') await act(owner, id, 'resolve').expect(200);
      return id;
    }
    const view = async (id: string) => (await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200)).body as RequestBody;
    return { owner, table, order, act, view };
  }

  const marker = async (guest: Guest) => (await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200)).body.marker as number;
  const mine = async (guest: Guest) => ((await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { id: string }[]).map((r) => r.id);
  const settleSession = (owner: Account, sessionId: string) => t.http.post(`${owner.base}/requests/settle-session`).set(owner.auth).send({ sessionId });
  const sessionOf = async (guest: Guest) => {
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(guest.token).digest('hex');
    return (await t.prisma.tableSession.findUniqueOrThrow({ where: { tokenHash } })).id;
  };
  const listAlerts = async (account: Account) =>
    (await t.http.get(`${account.base}/unpaid-alerts`).set(account.auth).expect(200)).body as { id: string; sessionId: string; amountMinor: number; marker: number; table: { label: string } }[];
  /** Recule la dernière activité d'une session de `minutes` (horloge simulée). */
  const idleFor = async (guest: Guest, minutes: number) =>
    t.prisma.tableSession.update({ where: { id: await sessionOf(guest) }, data: { lastActivityAt: new Date(Date.now() - minutes * 60_000) } });
  const sales = async (owner: Account) => (await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'month' }).set(owner.auth).expect(200)).body;

  it('CA-027-01 — le client ne voit que sa session', async () => {
    const { table, order } = await shop('Vue par client');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    const fromA = await order(a, 1, 'preparing');
    const fromB = await order(b, 2, 'served');
    expect(await mine(a)).toEqual([fromA]);
    expect(await mine(b)).toEqual([fromB]);
  });

  it('CA-027-02 — repères distincts sur une table, même en scans simultanés ; 17e téléphone refusé', async () => {
    const { table } = await shop('Repères');
    const opened = await Promise.all(Array.from({ length: 16 }, () => t.http.post('/api/v1/guest/sessions').send({ code: table.code })));
    expect(opened.map((res) => res.status)).toEqual(Array(16).fill(201));
    const markers = opened.map((res) => res.body.marker as number);
    expect(new Set(markers).size).toBe(16);
    const over = await t.http.post('/api/v1/guest/sessions').send({ code: table.code }).expect(429);
    expect(over.body.code).toBe('TOO_MANY_SESSIONS');
  });

  it('CA-027-03 — la commande porte le repère du client, côté personnel', async () => {
    const { table, order, view } = await shop('Repère côté personnel');
    await openSession(t, table.code);
    const guest = await openSession(t, table.code);
    const id = await order(guest, 1, 'pending');
    expect((await view(id)).marker).toBe(await marker(guest));
  });

  it('CA-027-04 — régler une session ne règle que ce client', async () => {
    const { owner, table, order, view } = await shop('Régler un client');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    const fromA = await order(a, 2, 'served');
    const fromB = await order(b, 3, 'served');
    const res = await settleSession(owner, await sessionOf(a)).expect(200);
    expect(res.body).toEqual({ settled: 1, amountMinor: 3000 });
    expect((await view(fromA)).paidAt).not.toBeNull();
    expect((await view(fromB)).paidAt).toBeNull();
    expect((await settleSession(owner, await sessionOf(a)).expect(409)).body.code).toBe('NOTHING_TO_SETTLE');
  });

  it('CA-027-05 — régler termine la session : commande refusée avec ce jeton', async () => {
    const { owner, table, order } = await shop('Fin de session');
    const guest = await openSession(t, table.code);
    await order(guest, 1, 'served');
    await settleSession(owner, await sessionOf(guest)).expect(200);
    const refused = await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [] });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('TABLE_SESSION_SETTLED');
    expect((await t.prisma.tableSession.findUniqueOrThrow({ where: { id: await sessionOf(guest) } })).status).toBe('settled');
  });

  it('CA-027-06 et 07 — rescan après règlement : nouvelle session, nouveau repère, note vide', async () => {
    const { owner, table, order } = await shop('Client suivant');
    const first = await openSession(t, table.code);
    await order(first, 1, 'served');
    const firstMarker = await marker(first);
    await settleSession(owner, await sessionOf(first)).expect(200);
    const next = await openSession(t, table.code);
    expect(await marker(next)).not.toBe(firstMarker);
    expect(await mine(next)).toEqual([]);
  });

  it('CA-027-08 — une session avec un reste à régler continue', async () => {
    const { table, order } = await shop('Session non réglée');
    const guest = await openSession(t, table.code);
    await order(guest, 1, 'served');
    const again = await order(guest, 1, 'pending');
    expect(await mine(guest)).toContain(again);
  });

  it('CA-027-09 — table « à régler » puis libre une fois tout réglé (spec 027, R4 et R7)', async () => {
    const { owner, table, order } = await shop('Couleur à régler');
    const guest = await openSession(t, table.code);
    await order(guest, 2, 'served');
    const status = async () =>
      ((await t.http.get(`${owner.base}/tables/overview`).set(owner.auth).expect(200)).body.tables as { id: string; status: string; unpaidMinor: number | null }[]).find(
        (row) => row.id === table.tableId,
      );
    expect(await status()).toMatchObject({ status: 'occupied', unpaidMinor: 3000 });
    await settleSession(owner, await sessionOf(guest)).expect(200);
    expect(await status()).toMatchObject({ status: 'free', unpaidMinor: null });
  });

  describe('zone de l’établissement', () => {
    async function zoned(name: string, radius = 150) {
      const s = await shop(name);
      await t.http.patch(s.owner.base).set(s.owner.auth).send({ zoneLatitude: CENTER.latitude, zoneLongitude: CENTER.longitude, zoneRadiusM: radius }).expect(200);
      const guest = await openSession(t, s.table.code);
      return { ...s, guest };
    }

    it('CA-027-10 — commande hors zone : créée, signalée avec la distance', async () => {
      const { guest, order, view } = await zoned('Hors zone');
      expect((await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200)).body.zone).toBe(true);
      const id = await order(guest, 1, 'pending', { location: north(2000) });
      expect((await view(id)).zone).toEqual({ status: 'outside', distanceM: 2000 });
    });

    it('CA-027-11 — position refusée : commande créée, signalée', async () => {
      const { guest, order, view } = await zoned('Position refusée');
      const id = await order(guest, 1, 'pending', { locationStatus: 'denied' });
      expect((await view(id)).zone).toEqual({ status: 'denied', distanceM: null });
    });

    it('CA-027-12 — position imprécise', async () => {
      const { guest, order, view } = await zoned('Position imprécise');
      const id = await order(guest, 1, 'pending', { location: north(10, 400) });
      expect((await view(id)).zone).toEqual({ status: 'imprecise', distanceM: null });
    });

    it('CA-027-13 — sans zone : rien n’est demandé ni signalé', async () => {
      const { table, order, view } = await shop('Sans zone');
      const guest = await openSession(t, table.code);
      expect((await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200)).body.zone).toBe(false);
      const id = await order(guest, 1, 'pending', { location: north(5000) });
      expect((await view(id)).zone).toBeNull();
    });

    it('CA-027-14 — la position du client n’est pas conservée', async () => {
      const { guest, order } = await zoned('Vie privée');
      const position = north(2345);
      const id = await order(guest, 1, 'pending', { location: position });
      const row = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ zoneCheck: 'outside', zoneDistanceM: 2300 });
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(String(position.latitude));
      expect(stored).not.toContain(String(position.longitude));
      const events = JSON.stringify(await t.prisma.serviceRequestEvent.findMany({ where: { requestId: id } }));
      expect(events).not.toContain(String(position.latitude));
    });

    it('CA-027-24 — rayon réglé à 300 m', async () => {
      const { guest, order, view } = await zoned('Rayon 300', 300);
      expect((await view(await order(guest, 1, 'pending', { location: north(250) }))).zone?.status).toBe('inside');
      expect((await view(await order(guest, 1, 'pending', { location: north(350) }))).zone?.status).toBe('outside');
    });
  });

  describe('alertes de départ sans payer', () => {
    it('CA-027-15 — alerte après 20 minutes sans activité, pas avant', async () => {
      const { owner, table, order } = await shop('Alerte 20 min');
      const guest = await openSession(t, table.code);
      await order(guest, 3, 'served');
      await idleFor(guest, 19);
      await alerts.sweep();
      expect(await listAlerts(owner)).toHaveLength(0);
      await idleFor(guest, 20);
      await alerts.sweep();
      const [alert] = await listAlerts(owner);
      expect(alert).toMatchObject({ amountMinor: 4500, marker: await marker(guest), table: { label: '2' } });
      await alerts.sweep();
      expect(await listAlerts(owner)).toHaveLength(1);
    });

    it('CA-027-16 — libérer avec un reste : une alerte par client concerné', async () => {
      const { owner, table, order } = await shop('Alerte à la libération');
      const a = await openSession(t, table.code);
      const b = await openSession(t, table.code);
      await openSession(t, table.code); // téléphone sans commande : pas d'alerte
      await order(a, 1, 'served');
      await order(b, 2, 'served');
      await t.http.post(`${owner.base}/tables/${table.tableId}/sessions/close`).set(owner.auth).expect(200);
      const list = await listAlerts(owner);
      expect(list.map((alert) => alert.amountMinor).sort()).toEqual([1500, 3000]);
    });

    async function withAlert(name: string) {
      const s = await shop(name);
      const guest = await openSession(t, s.table.code);
      const id = await s.order(guest, 3, 'served');
      await idleFor(guest, 25);
      await alerts.sweep();
      const [alert] = await listAlerts(s.owner);
      const resolve = (account: Account, resolution: string) => t.http.post(`${account.base}/unpaid-alerts/${alert.id}/resolve`).set(account.auth).send({ resolution });
      return { ...s, guest, id, alert, resolve };
    }

    it('CA-027-17 — « Client encore là » : l’alerte revient après un nouveau délai', async () => {
      const { owner, guest, resolve } = await withAlert('Client encore là');
      await resolve(owner, 'still_here').expect(200);
      expect(await listAlerts(owner)).toHaveLength(0);
      await alerts.sweep();
      expect(await listAlerts(owner)).toHaveLength(0);
      await alerts.sweep(new Date(Date.now() + 21 * 60_000));
      expect((await listAlerts(owner)).map((alert) => alert.marker)).toEqual([await marker(guest)]);
    });

    it('CA-027-18 et 21 — « Parti sans payer » : hors reste à encaisser, compté en impayés', async () => {
      const { owner, id, view, resolve } = await withAlert('Parti sans payer');
      expect((await sales(owner)).outstanding.amountMinor).toBe(4500);
      await resolve(owner, 'walked_out').expect(200);
      expect((await view(id)).writtenOffAt).not.toBeNull();
      const after = await sales(owner);
      expect(after.outstanding.amountMinor).toBe(0);
      expect(after.current).toMatchObject({ totalMinor: 4500, paidMinor: 0, writtenOffMinor: 4500, writtenOffCustomers: 1 });
      expect((await resolve(owner, 'paid').expect(409)).body.code).toBe('ALERT_RESOLVED');
    });

    it('CA-027-19 — « Réglé » depuis l’alerte : commandes réglées à son nom', async () => {
      const { owner, id, view, resolve } = await withAlert('Réglé depuis l’alerte');
      await resolve(owner, 'paid').expect(200);
      expect((await view(id)).paidAt).not.toBeNull();
      expect(await listAlerts(owner)).toHaveLength(0);
    });

    it('CA-027-20 — sans analytics.read : ni liste ni traitement', async () => {
      const { owner, alert } = await withAlert('Droits des alertes');
      const waiter = await addStaff(t, owner, 'waiter', 'Koffi');
      await t.http.get(`${waiter.base}/unpaid-alerts`).set(waiter.auth).expect(403);
      await t.http.post(`${waiter.base}/unpaid-alerts/${alert.id}/resolve`).set(waiter.auth).send({ resolution: 'walked_out' }).expect(403);
    });

    it('CA-027-22 — liste des impayés : table, repère, montant, heure, personne', async () => {
      const { owner, guest, resolve } = await withAlert('Liste des impayés');
      const guestMarker = await marker(guest);
      await resolve(owner, 'walked_out').expect(200);
      const list = (await t.http.get(`${owner.base}/analytics/unpaid`).query({ period: 'month' }).set(owner.auth).expect(200)).body;
      expect(list).toEqual([
        expect.objectContaining({ table: expect.objectContaining({ label: '2' }), marker: guestMarker, amountMinor: 4500, writtenOffBy: 'Awa Koné' }),
      ]);
      expect(Date.parse(list[0].writtenOffAt)).not.toBeNaN();
    });

    it('CA-027-23 — délai d’alerte réglé à 30 minutes', async () => {
      const { owner, table, order } = await shop('Délai 30 min');
      await t.http.patch(owner.base).set(owner.auth).send({ unpaidAlertMinutes: 30 }).expect(200);
      const guest = await openSession(t, table.code);
      await order(guest, 1, 'served');
      await idleFor(guest, 25);
      await alerts.sweep();
      expect(await listAlerts(owner)).toHaveLength(0);
      await idleFor(guest, 31);
      await alerts.sweep();
      expect(await listAlerts(owner)).toHaveLength(1);
    });
  });

  it('CA-027-25 — bornes des réglages et droits', async () => {
    const { owner } = await shop('Bornes');
    expect((await t.http.patch(owner.base).set(owner.auth).send({ zoneRadiusM: 20 }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    await t.http.patch(owner.base).set(owner.auth).send({ unpaidAlertMinutes: 90 }).expect(400);
    expect((await t.http.patch(owner.base).set(owner.auth).send({ zoneLatitude: 5.3 }).expect(422)).body.code).toBe('ZONE_INCOMPLETE');
    await t.http.patch(owner.base).set(owner.auth).send({ zoneLatitude: null, zoneLongitude: null }).expect(200);
    const waiter = await addStaff(t, owner, 'waiter', 'Ali');
    await t.http.patch(waiter.base).set(waiter.auth).send({ zoneRadiusM: 200 }).expect(403);
  });

  it('R6 — « L’addition » par client, « Appeler un serveur » commun à la table', async () => {
    const { table } = await shop('Addition par client');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    const types = (await t.http.get('/api/v1/guest/session').set(a.headers).expect(200)).body.requestTypes as { id: string; icon: string }[];
    const bill = types.find((type) => type.icon === 'receipt')!.id;
    const bell = types.find((type) => type.icon === 'bell')!.id;
    const ask = (guest: Guest, requestTypeId: string) => t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId }).expect(200);
    const billA = await ask(a, bill);
    const billB = await ask(b, bill);
    expect(billB.body.request.id).not.toBe(billA.body.request.id);
    const bellA = await ask(a, bell);
    const bellB = await ask(b, bell);
    expect(bellB.body.request.id).toBe(bellA.body.request.id);
    expect(await mine(b)).toContain(bellA.body.request.id);
    expect(await mine(b)).not.toContain(billA.body.request.id);
  });
});
