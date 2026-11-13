import { Account, addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

interface TodayHour {
  hour: string;
  waiting: number;
  progress: number;
  ready: number;
  resolved: number;
  cancelled: number;
}

interface TodayTopItem {
  menuItemId: string;
  name: string;
  quantity: number;
  rank: number;
  previousRank: number | null;
}

/**
 * Spec 008 — Tableau de bord : demandes par heure et top 3 des produits.
 * Chaque test cite le critère d'acceptation qu'il couvre (specs/008-tableau-de-bord-graphes/spec.md).
 * Le tenant de test est en UTC (Africa/Abidjan) : « 00:00 » et « 01:00 » d'aujourd'hui sont des heures sûres.
 */
describe('Spec 008 — tableau de bord du jour', () => {
  let t: TestApp;
  let owner: Account;
  let waiter: Account;
  let code: string;
  const items: Record<string, string> = {};

  const midnightUtc = () => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    return date;
  };
  const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'Maquis du Tableau');
    waiter = await addStaff(t, owner, 'waiter', 'Koffi');
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    for (const name of ['Garba', 'Alloco', 'Bissap', 'Dêguê']) {
      const item = await t.http
        .post(`${owner.base}/menu/items`)
        .set(owner.auth)
        .send({ categoryId: category.body.id, name, priceMinor: 1000 })
        .expect(201);
      items[name] = item.body.id as string;
    }
    // Plusieurs commandes depuis la même table : on relève la limite de demandes actives.
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200 }).expect(200);
    code = (await createTable(t, owner, 'D1')).code;
  });
  afterAll(() => t.close());

  const today = (who: Account) => t.http.get(`${who.base}/analytics/today`).set(who.auth);

  async function order(lines: Record<string, number>, createdAt?: Date): Promise<string> {
    const guest = await openSession(t, code);
    const res = await t.http
      .post('/api/v1/guest/orders')
      .set(guest.headers)
      .send({ items: Object.entries(lines).map(([name, quantity]) => ({ menuItemId: items[name], quantity })) })
      .expect(200);
    const id = res.body.request.id as string;
    if (createdAt) await t.prisma.serviceRequest.update({ where: { id }, data: { createdAt } });
    return id;
  }

  const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);

  it('CA-008-05 — l’API est refusée au serveur', async () => {
    await today(waiter).expect(403);
    await today(owner).expect(200);
  });

  it('CA-008-01 et CA-008-02 — heures par état, top 3 hors annulées', async () => {
    const midnight = midnightUtc();
    // 00 h : une terminée, une prise en charge, une annulée. 01 h : une en attente.
    const done = await order({ Garba: 5 }, at(midnight, 10));
    await act(done, 'prepare');
    await act(done, 'resolve');
    const taken = await order({ Alloco: 3 }, at(midnight, 20));
    await act(taken, 'prepare');
    const cancelled = await order({ Alloco: 4 }, at(midnight, 30));
    await act(cancelled, 'cancel');
    await order({ Bissap: 2, Dêguê: 1 }, at(midnight, 70));

    const body = (await today(owner).expect(200)).body as { hours: TodayHour[]; topItems: TodayTopItem[] };
    expect(body.hours[0]).toEqual({ hour: '00:00', waiting: 0, progress: 1, ready: 0, resolved: 1, cancelled: 1 });
    expect(body.hours[1]).toEqual({ hour: '01:00', waiting: 1, progress: 0, ready: 0, resolved: 0, cancelled: 0 });
    // Une barre par heure jusqu'à l'heure en cours.
    expect(body.hours[body.hours.length - 1].hour).toBe(`${String(new Date().getUTCHours()).padStart(2, '0')}:00`);

    expect(body.topItems.map((item) => [item.name, item.quantity, item.rank])).toEqual([
      ['Garba', 5, 1],
      ['Alloco', 3, 2],
      ['Bissap', 2, 3],
    ]);
  });

  it('CA-008-03 — le rang d’hier à la même heure donne la tendance', async () => {
    const yesterday = at(midnightUtc(), -24 * 60);
    // Hier, avant l'heure actuelle : Alloco 1er, Garba 2e, Bissap absent.
    await order({ Alloco: 6 }, at(yesterday, 5));
    await order({ Garba: 2 }, at(yesterday, 6));
    // Hier après l'heure actuelle : ne compte pas pour « hier à la même heure ».
    const later = new Date(Date.now() - 24 * 3_600_000 + 60_000);
    if (later.getUTCDate() === yesterday.getUTCDate()) await order({ Bissap: 9 }, later);

    const top = ((await today(owner).expect(200)).body as { topItems: TodayTopItem[] }).topItems;
    const byName = Object.fromEntries(top.map((item) => [item.name, item.previousRank]));
    expect(byName).toEqual({ Garba: 2, Alloco: 1, Bissap: null });
  });

  it('CA-008-06 — découpage mois / jour / heure avec filtres de date, date du jour par défaut', async () => {
    type Point = { period: string; waiting: number; progress: number; ready: number; resolved: number; cancelled: number };
    type Timeline = { points: Point[]; firstYear: number; today: string };
    const total = (p: Point) => p.waiting + p.progress + p.ready + p.resolved + p.cancelled;
    const timeline = async (query: Record<string, string | number>) =>
      (await t.http.get(`${owner.base}/analytics/timeline`).query(query).set(owner.auth).expect(200)).body as Timeline;

    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 3, 10, 0));
    const september = new Date(Date.UTC(lastMonth.getUTCFullYear(), 8, 20, 12, 0));
    await order({ Garba: 1 }, lastMonth);
    await order({ Garba: 1 }, september);

    // Par défaut : heure, date du jour (UTC pour ce tenant).
    const byDefault = await timeline({});
    expect(byDefault.today).toBe(now.toISOString().slice(0, 10));
    expect(byDefault.points.every((p) => p.period.startsWith(byDefault.today))).toBe(true);

    // Jour, mois dernier : une barre par jour du mois, dont le 3.
    const days = await timeline({ bucket: 'day', year: lastMonth.getUTCFullYear(), month: lastMonth.getUTCMonth() + 1 });
    const daysInMonth = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0)).getUTCDate();
    expect(days.points).toHaveLength(daysInMonth);
    expect(total(days.points.find((p) => p.period.startsWith(lastMonth.toISOString().slice(0, 10)))!)).toBe(1);

    // Mois, année : 12 barres, septembre compris.
    const months = await timeline({ bucket: 'month', year: september.getUTCFullYear() });
    expect(months.points).toHaveLength(12);
    expect(total(months.points[8])).toBeGreaterThanOrEqual(1);
    expect(months.firstYear).toBeLessThanOrEqual(september.getUTCFullYear());

    // Heure d'un jour passé : de la première à la dernière heure active.
    const hours = await timeline({ bucket: 'hour', year: lastMonth.getUTCFullYear(), month: lastMonth.getUTCMonth() + 1, day: 3 });
    expect(hours.points.map((p) => p.period.slice(11))).toEqual(['10:00']);

    // Date impossible, découpage inconnu, serveur.
    const invalid = await t.http.get(`${owner.base}/analytics/timeline`).query({ bucket: 'hour', year: 2026, month: 2, day: 31 }).set(owner.auth).expect(422);
    expect(invalid.body.code).toBe('INVALID_DATE');
    await t.http.get(`${owner.base}/analytics/timeline`).query({ bucket: 'year' }).set(owner.auth).expect(400);
    await t.http.get(`${waiter.base}/analytics/timeline`).set(waiter.auth).expect(403);
  });

  it('CA-008-07 — indicateurs de la période choisie, calculés comme la page Statistiques', async () => {
    const shop = await registerTenant(t, 'Maquis des Indicateurs');
    const category = await t.http.post(`${shop.base}/menu/categories`).set(shop.auth).send({ name: 'Plats' }).expect(201);
    const item = await t.http.post(`${shop.base}/menu/items`).set(shop.auth).send({ categoryId: category.body.id, name: 'Garba', priceMinor: 1000 }).expect(201);
    await t.http.patch(shop.base).set(shop.auth).send({ maxActiveRequestsPerTable: 20 }).expect(200);
    const table = await createTable(t, shop, 'K1');
    const base = new Date(Date.now() - 3_600_000);
    const place = async () => {
      const guest = await openSession(t, table.code);
      const res = await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId: item.body.id, quantity: 1 }] }).expect(200);
      return res.body.request.id as string;
    };
    const minutes = (m: number) => new Date(base.getTime() + m * 60_000);
    const stamp = async (id: string, data: object) => t.prisma.serviceRequest.update({ where: { id }, data });
    const quick = await place();
    await t.http.post(`${shop.base}/requests/${quick}/prepare`).set(shop.auth).send({}).expect(200);
    await t.http.post(`${shop.base}/requests/${quick}/resolve`).set(shop.auth).send({}).expect(200);
    await stamp(quick, { createdAt: base, dueAt: minutes(2), acceptedAt: minutes(1), resolvedAt: minutes(5) });
    const slow = await place();
    await t.http.post(`${shop.base}/requests/${slow}/prepare`).set(shop.auth).send({}).expect(200);
    await t.http.post(`${shop.base}/requests/${slow}/resolve`).set(shop.auth).send({}).expect(200);
    await stamp(slow, { createdAt: base, dueAt: minutes(2), acceptedAt: minutes(3), resolvedAt: minutes(9) });
    const dropped = await place();
    await t.http.post(`${shop.base}/requests/${dropped}/cancel`).set(shop.auth).send({}).expect(200);
    await stamp(dropped, { createdAt: base, dueAt: minutes(2), acceptedAt: null });

    const day = (await t.http.get(`${shop.base}/analytics/timeline`).set(shop.auth).expect(200)).body;
    expect(day.summary).toMatchObject({ total: 3, resolved: 2, cancelled: 1, late: 1, medianAcceptSeconds: 120, averageAcceptSeconds: 120, medianResolveSeconds: 420, averageResolveSeconds: 420 });
    const year = (await t.http.get(`${shop.base}/analytics/timeline`).query({ bucket: 'month' }).set(shop.auth).expect(200)).body;
    expect(year.summary.total).toBe(3);
  });
});
