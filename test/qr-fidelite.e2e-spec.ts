import { createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Specs 042 et 043 — QR imprimables, fidélité par tampons.
 * Chaque test cite le critère couvert.
 */
describe('Specs 042 et 043', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ 042

  it('CA-042-01 et CA-042-04 — QR d’une zone, correction H, QR régénérés à imprimer', async () => {
    const owner = await registerTenant(t, 'QR imprimables');
    const first = await createTable(t, owner, '1');
    const second = await createTable(t, owner, '2');
    const list = async () =>
      (await t.http.get(`${owner.base}/qr-codes`).set(owner.auth).expect(200)).body as { tableId: string; areaId: string; printedAt: string | null; svg: string; url: string }[];
    const before = await list();
    expect(before.every((qr) => qr.printedAt === null && qr.svg.startsWith('<svg'))).toBe(true);
    expect(before.find((qr) => qr.tableId === first.tableId)!.url).toContain(`/t/${first.code}`);
    await t.http.post(`${owner.base}/qr-codes/printed`).set(owner.auth).send({ tableIds: [first.tableId, second.tableId] }).expect(200);
    expect((await list()).every((qr) => qr.printedAt !== null)).toBe(true);
    await t.http.post(`${owner.base}/tables/${second.tableId}/qr/regenerate`).set(owner.auth).send({}).expect(200);
    const toPrint = (await list()).filter((qr) => qr.printedAt === null).map((qr) => qr.tableId);
    expect(toPrint).toEqual([second.tableId]);
  });

  // ------------------------------------------------------------------ 043

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201)).body.id as string;
    const dish = async (dishName: string, priceMinor: number) =>
      (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: dishName, priceMinor }).expect(201)).body.id as string;
    const garba = await dish('Garba', 2500);
    const coca = await dish('Coca', 500);
    const poulet = await dish('Poulet braisé', 3500);
    const table = await createTable(t, owner, '1');
    const attach = async (guest: Guest, token?: string) => (await t.http.post('/api/v1/guest/loyalty/attach').set(guest.headers).send(token ? { token } : {}).expect(200)).body;
    return { owner, garba, coca, poulet, table, attach };
  }

  it('CA-043-05 — un compte Essentiel ne crée pas de carte ; Pro, oui', async () => {
    const { owner, poulet } = await shop('Fidélité formule');
    await t.prisma.tenant.updateMany({ where: { users: { some: { id: owner.userId } } }, data: { plan: 'essentiel' } });
    const body = { stampsRequired: 10, minOrderMinor: 2000, rewardItemId: poulet };
    expect((await t.http.put(`${owner.base}/loyalty`).set(owner.auth).send(body).expect(403)).body.code).toBe('PLAN_FEATURE_LOCKED');
    await t.prisma.tenant.updateMany({ where: { users: { some: { id: owner.userId } } }, data: { plan: 'pro' } });
    await t.http.put(`${owner.base}/loyalty`).set(owner.auth).send(body).expect(200);
  });

  it('CA-043-01, CA-043-02 et CA-043-04 — tampon au règlement, un par visite, la carte suit le téléphone', async () => {
    const { owner, garba, coca, poulet, table, attach } = await shop('Fidélité tampons');
    await t.http.put(`${owner.base}/loyalty`).set(owner.auth).send({ stampsRequired: 5, minOrderMinor: 2000, rewardItemId: poulet }).expect(200);
    const stamps = async () => (await t.prisma.loyaltyCard.findFirstOrThrow({ where: { establishmentId: owner.establishmentId } })).stamps;
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);
    const order = async (guest: Guest, menuItemId: string) =>
      (await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId, quantity: 1 }] }).expect(200)).body.request.id as string;
    const serveAndPay = async (id: string) => {
      await act(id, 'prepare');
      await act(id, 'resolve');
      await act(id, 'settle');
    };

    // Visite 1 : une carte est créée ; une commande de 500 F ne donne pas de tampon.
    const first = await openSession(t, table.code);
    const card = await attach(first);
    expect(card).toMatchObject({ stamps: 0, stampsRequired: 5 });
    expect(card.token).toBeTruthy();
    await serveAndPay(await order(first, coca));
    expect(await stamps()).toBe(0);

    // Visite 2 (le lendemain) : la même carte revient ; deux commandes réglées ne donnent qu'un tampon.
    const second = await openSession(t, table.code);
    const again = await attach(second, card.token);
    expect(again.stamps).toBe(0);
    expect(again.token).toBeUndefined();
    const a = await order(second, garba);
    const b = await order(second, garba);
    await serveAndPay(a);
    await serveAndPay(b);
    expect(await stamps()).toBe(1);
  });

  it('CA-043-03 — carte pleine : récompense demandée, validée par un serveur, commande offerte', async () => {
    const { owner, poulet, table, attach } = await shop('Fidélité récompense');
    await t.http.put(`${owner.base}/loyalty`).set(owner.auth).send({ stampsRequired: 5, minOrderMinor: 0, rewardItemId: poulet }).expect(200);
    const guest = await openSession(t, table.code);
    const card = await attach(guest);
    await t.prisma.loyaltyCard.updateMany({ where: { establishmentId: owner.establishmentId }, data: { stamps: 5 } });
    expect(card.stamps).toBe(0);
    const asked = await t.http.post('/api/v1/guest/loyalty/redeem').set(guest.headers).send({}).expect(200);
    expect(asked.body.redemption).toMatchObject({ validated: false });
    expect((await t.http.post('/api/v1/guest/loyalty/redeem').set(guest.headers).send({}).expect(409)).body.code).toBe('ALREADY_REDEEMED');
    const pending = (await t.http.get(`${owner.base}/loyalty/redemptions`).set(owner.auth).expect(200)).body as { id: string; reward: { name: string } }[];
    expect(pending[0].reward.name).toBe('Poulet braisé');
    await t.http.post(`${owner.base}/loyalty/redemptions/${pending[0].id}/validate`).set(owner.auth).send({}).expect(200);
    const after = (await t.http.get('/api/v1/guest/loyalty').set(guest.headers).expect(200)).body;
    expect(after).toMatchObject({ stamps: 0, redemption: { validated: true } });
    const orders = (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { totalMinor: number; items: { name: string; offeredAt: string | null }[] }[];
    const reward = orders.find((order) => order.items[0]?.name === 'Poulet braisé')!;
    expect(reward.totalMinor).toBe(0);
    expect(reward.items[0].offeredAt).not.toBeNull();
  });
});
