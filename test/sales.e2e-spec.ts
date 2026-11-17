import { Account, addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

interface Figures {
  totalMinor: number;
  orders: number;
  passages: number;
  averageMinor: number | null;
}

interface Sales {
  currency: string;
  period: 'month' | 'year';
  from: string;
  current: Figures;
  previous: Figures;
}

/**
 * Spec 009 — Tableau de bord : ventes du mois et de l'année.
 * Chaque test cite le critère couvert (specs/009-tableau-de-bord-ventes/spec.md).
 * Les tenants de test sont en UTC (Africa/Abidjan). Les dates sont placées dans le mois en cours,
 * avant l'heure actuelle : le test suppose qu'on n'est pas dans les toutes premières heures du mois.
 */
describe('Spec 009 — ventes du tableau de bord', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  const now = () => new Date();
  const monthStart = () => new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 1));
  const at = (base: Date, hours: number) => new Date(base.getTime() + hours * 3_600_000);

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200 }).expect(200);
    const category = await t.http.post(`${owner.base}/menu/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201);
    const prices: Record<number, string> = {};
    for (const priceMinor of [1000, 2000, 3000, 4000, 4500, 10000, 12000]) {
      const item = await t.http
        .post(`${owner.base}/menu/items`)
        .set(owner.auth)
        .send({ categoryId: category.body.id, name: `Plat ${priceMinor}`, priceMinor })
        .expect(201);
      prices[priceMinor] = item.body.id as string;
    }
    const tables = { A: await createTable(t, owner, 'A'), B: await createTable(t, owner, 'B') };
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);

    /** Passe une commande ; `state` : servie (dates forcées), en préparation ou annulée. */
    async function order(table: 'A' | 'B', priceMinor: number, state: 'served' | 'preparing' | 'cancelled', when?: Date) {
      const guest = await openSession(t, tables[table].code);
      const res = await t.http
        .post('/api/v1/guest/orders')
        .set(guest.headers)
        .send({ items: [{ menuItemId: prices[priceMinor], quantity: 1 }] })
        .expect(200);
      const id = res.body.request.id as string;
      if (state === 'cancelled') await act(id, 'cancel');
      else await act(id, 'prepare');
      if (state === 'served') await act(id, 'resolve');
      if (when) await t.prisma.serviceRequest.update({ where: { id }, data: { createdAt: when, resolvedAt: state === 'served' ? when : null } });
      return id;
    }
    const sales = async (period: 'month' | 'year' = 'month') =>
      (await t.http.get(`${owner.base}/analytics/sales`).query({ period }).set(owner.auth).expect(200)).body as Sales;
    return { owner, order, sales };
  }

  it('CA-009-01 — total vendu du mois : seules les commandes servies comptent', async () => {
    const { order, sales } = await shop('Ventes du mois');
    await order('A', 3000, 'served', at(monthStart(), 2));
    await order('A', 4500, 'served', at(monthStart(), 30));
    await order('B', 2000, 'preparing');
    await order('B', 1000, 'cancelled');
    const body = await sales();
    expect(body.currency).toBe('XOF');
    expect(body.period).toBe('month');
    expect(body.from).toBe(monthStart().toISOString().slice(0, 10));
    expect(body.current).toMatchObject({ totalMinor: 7500, orders: 2 });
  });

  it('CA-009-02 — moyenne par passage : plus de 2 h d’écart ouvre un nouveau passage', async () => {
    const { order, sales } = await shop('Ventes par passage');
    const noon = at(monthStart(), 24 + 12);
    await order('A', 3000, 'served', noon);
    await order('A', 2000, 'served', at(noon, 1));
    await order('A', 4000, 'served', at(noon, 7));
    const { current } = await sales();
    expect(current).toMatchObject({ totalMinor: 9000, orders: 3, passages: 2, averageMinor: 4500 });
  });

  it('CA-009-03 — comparaison avec la même durée du mois précédent', async () => {
    const { order, sales } = await shop('Ventes comparées');
    const previousStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth() - 1, 1));
    await order('A', 10000, 'served', at(previousStart, 10));
    // Après la date du jour, le mois dernier : hors de la même durée, ne compte pas.
    const lateLastMonth = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 0, 23));
    if (lateLastMonth.getUTCDate() > now().getUTCDate()) {
      await order('B', 4000, 'served', lateLastMonth);
    }
    await order('A', 12000, 'served', at(monthStart(), 3));
    const body = await sales();
    expect(body.current.totalMinor).toBe(12000);
    expect(body.previous.totalMinor).toBe(10000);
    expect(body.previous.averageMinor).toBe(10000);
  });

  it('CA-009-04 — annuel : toute l’année en cours, comparée à l’année précédente', async () => {
    const { order, sales } = await shop('Ventes de l’année');
    const year = now().getUTCFullYear();
    await order('A', 3000, 'served', new Date(Date.UTC(year, 0, 2, 12)));
    await order('A', 2000, 'served', at(monthStart(), 5));
    await order('B', 4000, 'served', new Date(Date.UTC(year - 1, 0, 2, 12)));
    const body = await sales('year');
    expect(body.from).toBe(`${year}-01-01`);
    expect(body.current.totalMinor).toBe(5000);
    expect(body.previous.totalMinor).toBe(4000);
  });

  it('CA-009-05 — l’API est refusée au serveur', async () => {
    const { owner } = await shop('Ventes réservées');
    const waiter: Account = await addStaff(t, owner, 'waiter', 'Koffi');
    await t.http.get(`${waiter.base}/analytics/sales`).set(waiter.auth).expect(403);
    await t.http.get(`${owner.base}/analytics/sales`).query({ period: 'week' }).set(owner.auth).expect(400);
  });
});
