import { createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 032 — Les formules (packs).
 * Chaque test cite le critère couvert (specs/032-formules-packs/spec.md).
 */
describe('Spec 032 — formules', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  interface Item {
    id: string;
    name: string;
    isBundle: boolean;
    isAvailable: boolean;
    groups: { id: string; name: string; choiceIds: string[] }[];
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Midi' }).expect(201)).body.id as string;
    const dish = async (dishName: string, priceMinor: number) =>
      (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: dishName, priceMinor }).expect(201)).body as Item;
    const garba = await dish('Garba', 1500);
    const alloco = await dish('Alloco', 1000);
    const coca = await dish('Coca', 500);
    const bissap = await dish('Bissap', 500);
    const createBundle = (body: Record<string, unknown>) => t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, ...body });
    const bundle = (
      await createBundle({
        name: 'Menu midi',
        priceMinor: 2500,
        groups: [
          { name: 'Plat', choiceIds: [garba.id, alloco.id] },
          { name: 'Boisson', choiceIds: [coca.id, bissap.id] },
        ],
      }).expect(201)
    ).body as Item;
    const table = await createTable(t, owner, '1');
    const guest = await openSession(t, table.code);
    const guestMenu = async (who: Guest = guest) =>
      ((await t.http.get('/api/v1/guest/session').set(who.headers).expect(200)).body.menu as { items: Item[] }[]).flatMap((c) => c.items);
    const order = (lines: unknown[]) => t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: lines });
    return { owner, menu, category, garba, alloco, coca, bissap, bundle, createBundle, guest, guestMenu, order };
  }

  const choose = (bundle: Item, plat: string, boisson: string) => [
    { groupId: bundle.groups[0].id, menuItemId: plat },
    { groupId: bundle.groups[1].id, menuItemId: boisson },
  ];

  it('CA-032-01 — créer une formule ; rubrique vide ou plat d’un autre établissement refusés', async () => {
    const { bundle, garba, guestMenu, createBundle } = await shop('Formule création');
    expect(bundle.isBundle).toBe(true);
    expect(bundle.groups.map((group) => group.name)).toEqual(['Plat', 'Boisson']);
    const seen = (await guestMenu()).find((item) => item.id === bundle.id)!;
    expect(seen).toMatchObject({ isBundle: true, isAvailable: true });
    expect((await createBundle({ name: 'Vide', priceMinor: 1000, groups: [{ name: 'Plat', choiceIds: [] }] }).expect(400)).status).toBe(400);
    const other = await shop('Formule voisin');
    expect((await createBundle({ name: 'Volée', priceMinor: 1000, groups: [{ name: 'Plat', choiceIds: [other.garba.id] }] }).expect(422)).body.code).toBe(
      'BUNDLE_CHOICE_INVALID',
    );
    // Une formule ne se compose pas d'une autre formule.
    await createBundle({ name: 'Gigogne', priceMinor: 1000, groups: [{ name: 'Pack', choiceIds: [bundle.id, garba.id] }] }).expect(422);
  });

  it('CA-032-03 — commander une formule : prix unique, choix figés', async () => {
    const { owner, menu, bundle, garba, coca, order } = await shop('Formule commande');
    const res = await order([{ menuItemId: bundle.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) }]).expect(200);
    expect(res.body.request.totalMinor).toBe(2500);
    expect(res.body.request.items).toEqual([
      expect.objectContaining({
        name: 'Menu midi',
        unitPriceMinor: 2500,
        choices: [
          { group: 'Plat', menuItemId: garba.id, name: 'Garba' },
          { group: 'Boisson', menuItemId: coca.id, name: 'Coca' },
        ],
      }),
    ]);
    await t.http.patch(`${menu}/items/${bundle.id}`).set(owner.auth).send({ name: 'Menu du jour', priceMinor: 3000 }).expect(200);
    const after = await t.http.get(`${owner.base}/requests/${res.body.request.id}`).set(owner.auth).expect(200);
    expect(after.body.items[0]).toMatchObject({ name: 'Menu midi', unitPriceMinor: 2500 });
  });

  it('CA-032-03 — deux compositions différentes font deux lignes', async () => {
    const { bundle, garba, alloco, coca, bissap, order } = await shop('Formule deux lignes');
    const res = await order([
      { menuItemId: bundle.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) },
      { menuItemId: bundle.id, quantity: 2, choices: choose(bundle, alloco.id, bissap.id) },
    ]).expect(200);
    expect(res.body.request.items).toHaveLength(2);
    expect(res.body.request.totalMinor).toBe(7500);
  });

  it('CA-032-04 — choix hors rubrique ou rubrique omise refusés par l’API', async () => {
    const { bundle, garba, coca, order } = await shop('Formule contrôle');
    expect((await order([{ menuItemId: bundle.id, quantity: 1, choices: choose(bundle, coca.id, garba.id) }]).expect(422)).body.code).toBe('BUNDLE_CHOICE_INVALID');
    expect((await order([{ menuItemId: bundle.id, quantity: 1, choices: [{ groupId: bundle.groups[0].id, menuItemId: garba.id }] }]).expect(422)).body.code).toBe(
      'BUNDLE_CHOICE_INVALID',
    );
    expect((await order([{ menuItemId: bundle.id, quantity: 1 }]).expect(422)).body.code).toBe('BUNDLE_CHOICE_INVALID');
    expect((await order([{ menuItemId: garba.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) }]).expect(422)).body.code).toBe('BUNDLE_CHOICE_INVALID');
  });

  it('CA-032-05 — toutes les boissons en rupture : la formule est en rupture', async () => {
    const { owner, menu, bundle, garba, coca, bissap, guestMenu, order } = await shop('Formule rupture');
    await t.http.patch(`${menu}/items/${coca.id}`).set(owner.auth).send({ isAvailable: false }).expect(200);
    expect((await order([{ menuItemId: bundle.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) }]).expect(422)).body.code).toBe('MENU_ITEM_UNAVAILABLE');
    expect((await guestMenu()).find((item) => item.id === bundle.id)!.isAvailable).toBe(true);
    await t.http.patch(`${menu}/items/${bissap.id}`).set(owner.auth).send({ isAvailable: false }).expect(200);
    expect((await guestMenu()).find((item) => item.id === bundle.id)!.isAvailable).toBe(false);
  });

  it('R7 — un plat archivé disparaît des rubriques', async () => {
    const { owner, menu, bundle, coca, guestMenu } = await shop('Formule archive');
    await t.http.delete(`${menu}/items/${coca.id}`).set(owner.auth).expect(204);
    const seen = (await guestMenu()).find((item) => item.id === bundle.id)!;
    expect(seen.groups[1].choiceIds).not.toContain(coca.id);
  });

  it('CA-032-06 — côté personnel, la commande porte la formule et ses choix', async () => {
    const { owner, bundle, garba, coca, order } = await shop('Formule personnel');
    const res = await order([{ menuItemId: bundle.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) }]).expect(200);
    const list = await t.http.get(`${owner.base}/requests`).query({ scope: 'active' }).set(owner.auth).expect(200);
    const seen = (list.body.items as { id: string; items: { choices: { name: string }[] }[] }[]).find((r) => r.id === res.body.request.id)!;
    expect(seen.items[0].choices.map((choice) => choice.name)).toEqual(['Garba', 'Coca']);
  });

  it('CA-032-07 — la formule compte dans les ventes et le top des produits', async () => {
    const { owner, bundle, garba, coca, order } = await shop('Formule ventes');
    const res = await order([{ menuItemId: bundle.id, quantity: 1, choices: choose(bundle, garba.id, coca.id) }]).expect(200);
    const act = (action: string) => t.http.post(`${owner.base}/requests/${res.body.request.id}/${action}`).set(owner.auth).send({});
    await act('prepare').expect(200);
    await act('resolve').expect(200);
    const today = (await t.http.get(`${owner.base}/analytics/today`).set(owner.auth).expect(200)).body as { topItems: { name: string; quantity: number }[] };
    expect(today.topItems.map((item) => [item.name, item.quantity])).toEqual([['Menu midi', 1]]);
  });
});
