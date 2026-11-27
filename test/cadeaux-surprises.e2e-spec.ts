import { createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 046 — cadeaux surprises : panier, tirage côté serveur, déballage, utilisation.
 * Chaque test cite le critère couvert. Seuil min = max pour rendre le déblocage déterministe.
 */
describe('Spec 046 — cadeaux surprises', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  interface GiftView {
    id: string;
    state: string;
    revealed: boolean;
    atStamp: number;
    celebrate: boolean;
    prize: { name: string; imageId: string | null; kind: string } | null;
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const menu = `${owner.base}/menu`;
    const category = (await t.http.post(`${menu}/categories`).set(owner.auth).send({ name: 'Plats' }).expect(201)).body.id as string;
    const dish = async (dishName: string, priceMinor: number) =>
      (await t.http.post(`${menu}/items`).set(owner.auth).send({ categoryId: category, name: dishName, priceMinor }).expect(201)).body.id as string;
    const garba = await dish('Garba', 2500);
    const coca = await dish('Coca', 500);
    const table = await createTable(t, owner, '1');
    const loyalty = `${owner.base}/loyalty`;
    const prize = async (body: Record<string, unknown>, status = 201) => (await t.http.post(`${loyalty}/prizes`).set(owner.auth).send(body).expect(status)).body;
    const program = (body: Record<string, unknown>, status = 200) => t.http.put(loyalty).set(owner.auth).send({ minOrderMinor: 2000, ...body }).expect(status);
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);
    let cardToken: string | undefined;

    /** Une visite : nouvelle session, carte présentée, commande de Garba servie et réglée (la session se termine). */
    const visit = async (): Promise<Guest> => {
      const guest = await openSession(t, table.code);
      const card = (await t.http.post('/api/v1/guest/loyalty/attach').set(guest.headers).send(cardToken ? { token: cardToken } : {}).expect(200)).body;
      cardToken ??= card.token;
      const id = (await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: [{ menuItemId: garba, quantity: 1 }] }).expect(200)).body.request.id as string;
      await act(id, 'prepare');
      await act(id, 'resolve');
      await act(id, 'settle');
      return guest;
    };
    /** Une session ouverte, carte présentée, sans commande. */
    const sit = async (): Promise<Guest> => {
      const guest = await openSession(t, table.code);
      const attached = (await t.http.post('/api/v1/guest/loyalty/attach').set(guest.headers).send(cardToken ? { token: cardToken } : {}).expect(200)).body;
      cardToken ??= attached.token;
      return guest;
    };
    const card = async (guest: Guest) => (await t.http.get('/api/v1/guest/loyalty').set(guest.headers).expect(200)).body;
    const gifts = async (guest: Guest) => (await card(guest)).surprise.gifts as GiftView[];
    return { owner, garba, coca, table, loyalty, prize, program, visit, sit, card, gifts };
  }

  it('CA-046-01 — panier valide : un lot sans limite obligatoire, minimum ≤ maximum', async () => {
    const { prize, program, loyalty, owner } = await shop('Surprise panier');
    expect((await program({ mode: 'surprise', surpriseMin: 2, surpriseMax: 5 }, 422)).body.code).toBe('PRIZES_REQUIRED');
    const limited = await prize({ kind: 'free', name: 'Bon pour un jus', weight: 10, monthlyStock: 5 });
    expect((await program({ mode: 'surprise', surpriseMin: 2, surpriseMax: 5 }, 422)).body.code).toBe('UNLIMITED_PRIZE_REQUIRED');
    const candy = await prize({ kind: 'free', name: 'Bonbons', weight: 40 });
    expect((await program({ mode: 'surprise', surpriseMin: 5, surpriseMax: 2 }, 422)).body.code).toBe('INVALID_RANGE');
    await program({ mode: 'surprise', surpriseMin: 2, surpriseMax: 5 });
    // Mode Surprise actif : on ne retire ni ne limite le dernier lot sans limite.
    expect((await t.http.delete(`${loyalty}/prizes/${candy.id}`).set(owner.auth).expect(422)).body.code).toBe('UNLIMITED_PRIZE_REQUIRED');
    expect((await t.http.patch(`${loyalty}/prizes/${candy.id}`).set(owner.auth).send({ monthlyStock: 3 }).expect(422)).body.code).toBe('UNLIMITED_PRIZE_REQUIRED');
    await t.http.delete(`${loyalty}/prizes/${limited.id}`).set(owner.auth).expect(204);
    const basket = (await t.http.get(`${loyalty}/prizes`).set(owner.auth).expect(200)).body as { name: string }[];
    expect(basket.map((row) => row.name)).toEqual(['Bonbons']);
    // Un lot libre sans nom est refusé ; un plat de la carte prend le nom du plat.
    await prize({ kind: 'free', weight: 10 }, 400);
  });

  it('CA-046-02, CA-046-03 et CA-046-05 — déblocage au règlement qui atteint le seuil, contenu secret, lisible depuis « Réglé · Merci »', async () => {
    const { prize, program, visit, card } = await shop('Surprise déblocage');
    await prize({ kind: 'free', name: 'Bonbons secrets', weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 2, surpriseMax: 2 });

    const first = await visit();
    const afterOne = await card(first);
    expect(afterOne).toMatchObject({ mode: 'surprise', stamps: 1, surprise: { giftsReceived: 0, gifts: [] } });

    const second = await visit();
    // La session est réglée : la lecture de la carte reste permise (écran « Réglé · Merci »).
    const afterTwo = await card(second);
    expect(afterTwo.surprise.giftsReceived).toBe(1);
    expect(afterTwo.surprise.gifts[0]).toMatchObject({ state: 'wrapped', revealed: false, atStamp: 2, celebrate: true, prize: null });
    const raw = JSON.stringify(afterTwo);
    expect(raw).not.toContain('Bonbons secrets');
    // R5 révisée : on sait quand (prochain cadeau à 4 tampons), pas quoi.
    expect(afterTwo.surprise).toMatchObject({ nextAt: 4, remaining: 2 });
    // Commander reste interdit à une session réglée.
    await t.http.post('/api/v1/guest/orders').set(second.headers).send({ items: [] }).expect(401);

    // Fêté une fois : les feux ne se rejouent pas.
    await t.http.post(`/api/v1/guest/loyalty/gifts/${afterTwo.surprise.gifts[0].id}/celebrated`).set(second.headers).expect(204);
    expect((await card(second)).surprise.gifts[0].celebrate).toBe(false);

    // Le prochain seuil est retiré : 2 commandes plus tard (min = max = 2).
    const third = await visit();
    expect((await card(third)).surprise.giftsReceived).toBe(1);
    const fourth = await visit();
    expect((await card(fourth)).surprise.giftsReceived).toBe(2);
  });

  it('CA-046-04 — un lot épuisé ce mois n’est pas tiré', async () => {
    const { prize, program, visit, gifts, owner } = await shop('Surprise stock');
    const rare = await prize({ kind: 'free', name: 'Rare', weight: 100, monthlyStock: 1 });
    await prize({ kind: 'free', name: 'Bonbons', weight: 1 });
    await program({ mode: 'surprise', surpriseMin: 1, surpriseMax: 1 });
    await t.prisma.loyaltyPrizeDraw.create({ data: { tenantId: (await t.prisma.loyaltyPrize.findUniqueOrThrow({ where: { id: rare.id } })).tenantId, establishmentId: owner.establishmentId, prizeId: rare.id, month: new Date().toISOString().slice(0, 7), count: 1 } });
    for (let index = 0; index < 3; index += 1) {
      const guest = await visit();
      const [latest] = await gifts(guest);
      const revealed = (await t.http.post(`/api/v1/guest/loyalty/gifts/${latest.id}/reveal`).set(guest.headers).expect(200)).body as GiftView;
      expect(revealed.prize?.name).toBe('Bonbons');
    }
  });

  it('CA-046-06 — déballer révèle le lot et note l’heure', async () => {
    const { prize, program, visit, gifts, coca } = await shop('Surprise déballage');
    await prize({ kind: 'menu_item', menuItemId: coca, weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 1, surpriseMax: 1 });
    const guest = await visit();
    const [wrapped] = await gifts(guest);
    expect(wrapped.prize).toBeNull();
    const revealed = (await t.http.post(`/api/v1/guest/loyalty/gifts/${wrapped.id}/reveal`).set(guest.headers).expect(200)).body as GiftView;
    expect(revealed).toMatchObject({ state: 'won', revealed: true, prize: { name: 'Coca', kind: 'menu_item' } });
    expect((await t.prisma.loyaltyGift.findUniqueOrThrow({ where: { id: wrapped.id } })).revealedAt).not.toBeNull();
  });

  it('CA-046-07 et CA-046-09 — utiliser un plat : commande offerte après validation, un cadeau par visite', async () => {
    const { prize, program, visit, sit, gifts, coca, owner, loyalty } = await shop('Surprise plat');
    await prize({ kind: 'menu_item', menuItemId: coca, weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 1, surpriseMax: 1 });
    const one = await visit();
    const two = await visit();
    for (const gift of await gifts(two)) await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/reveal`).set(two.headers).expect(200);
    const [a, b] = await gifts(two);
    expect(one).toBeTruthy();

    const guest = await sit();
    // Utiliser exige une session ouverte : la session réglée est refusée.
    await t.http.post(`/api/v1/guest/loyalty/gifts/${a.id}/use`).set(two.headers).expect(401);
    const asked = (await t.http.post(`/api/v1/guest/loyalty/gifts/${a.id}/use`).set(guest.headers).expect(200)).body as GiftView;
    expect(asked.state).toBe('requested');
    expect((await t.http.post(`/api/v1/guest/loyalty/gifts/${b.id}/use`).set(guest.headers).expect(409)).body.code).toBe('GIFT_ONE_PER_VISIT');

    const pending = (await t.http.get(`${loyalty}/redemptions`).set(owner.auth).expect(200)).body as { id: string; kind: string; prizeKind: string; reward: { name: string } }[];
    const row = pending.find((entry) => entry.id === a.id)!;
    expect(row).toMatchObject({ kind: 'gift', prizeKind: 'menu_item', reward: { name: 'Coca' } });
    await t.http.post(`${loyalty}/gifts/${a.id}/validate`).set(owner.auth).send({}).expect(200);
    expect((await t.http.post(`${loyalty}/gifts/${a.id}/validate`).set(owner.auth).send({}).expect(409)).body.code).toBe('ALREADY_VALIDATED');
    const orders = (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { totalMinor: number; items: { name: string; offeredAt: string | null }[] }[];
    const offered = orders.find((order) => order.items[0]?.name === 'Coca')!;
    expect(offered.totalMinor).toBe(0);
    expect(offered.items[0].offeredAt).not.toBeNull();
    expect((await gifts(guest)).find((gift) => gift.id === a.id)?.state).toBe('used');
  });

  it('CA-046-08 — utiliser un lot libre : « Remis », sans ligne dans l’addition', async () => {
    const { prize, program, visit, sit, gifts, owner, loyalty } = await shop('Surprise lot libre');
    await prize({ kind: 'free', name: 'Bonbons', weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 1, surpriseMax: 1 });
    const settled = await visit();
    const [gift] = await gifts(settled);
    await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/reveal`).set(settled.headers).expect(200);
    const guest = await sit();
    await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/use`).set(guest.headers).expect(200);
    await t.http.post(`${loyalty}/gifts/${gift.id}/validate`).set(owner.auth).send({}).expect(200);
    const orders = (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as unknown[];
    expect(orders).toHaveLength(0);
    expect((await gifts(guest))[0].state).toBe('used');
  });

  it('CA-046-10 — un cadeau expiré ne s’utilise plus ; il faut le déballer avant', async () => {
    const { prize, program, visit, sit, gifts } = await shop('Surprise expiration');
    await prize({ kind: 'free', name: 'Bonbons', weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 1, surpriseMax: 1, giftValidityDays: 30 });
    const settled = await visit();
    const [gift] = await gifts(settled);
    const stored = await t.prisma.loyaltyGift.findUniqueOrThrow({ where: { id: gift.id } });
    expect(stored.expiresAt.getTime() - stored.unlockedAt.getTime()).toBe(30 * 86_400_000);
    const guest = await sit();
    expect((await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/use`).set(guest.headers).expect(422)).body.code).toBe('GIFT_WRAPPED');
    await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/reveal`).set(guest.headers).expect(200);
    await t.prisma.loyaltyGift.update({ where: { id: gift.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
    expect((await gifts(guest))[0].state).toBe('expired');
    expect((await t.http.post(`/api/v1/guest/loyalty/gifts/${gift.id}/use`).set(guest.headers).expect(422)).body.code).toBe('GIFT_EXPIRED');
  });

  it('CA-046-11 — mode Classique inchangé ; passer en Surprise reprend les tampons en cours (Q10)', async () => {
    const { prize, program, visit, sit, card, garba } = await shop('Surprise classique');
    await program({ stampsRequired: 5, rewardItemId: garba });
    const first = await visit();
    const classic = await card(first);
    expect(classic).toMatchObject({ mode: 'classic', stamps: 1, stampsRequired: 5, rewardItemId: garba, surprise: null });
    await visit();
    // Deux tampons en cours ; seuil 3 : le premier cadeau arrive à la troisième commande.
    await prize({ kind: 'free', name: 'Bonbons', weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 3, surpriseMax: 3 });
    const third = await visit();
    expect((await card(third)).surprise.giftsReceived).toBe(1);
    // Le mode Surprise refuse la récompense classique.
    const guest = await sit();
    expect((await t.http.post('/api/v1/guest/loyalty/redeem').set(guest.headers).send({}).expect(422)).body.code).toBe('LOYALTY_MODE');
  });

  it('CA-046-13 — on sait quand : seuil tiré dès la carte, commandes restantes', async () => {
    const { prize, program, visit, sit, card } = await shop('Surprise quand');
    await prize({ kind: 'free', name: 'Bonbons', weight: 10 });
    await program({ mode: 'surprise', surpriseMin: 3, surpriseMax: 3 });
    // Carte neuve, avant toute commande.
    expect((await card(await sit())).surprise).toMatchObject({ nextAt: 3, remaining: 3, giftsReceived: 0 });
    const first = await visit();
    expect((await card(first)).surprise).toMatchObject({ nextAt: 3, remaining: 2 });
    await visit();
    const third = await visit();
    expect((await card(third)).surprise).toMatchObject({ giftsReceived: 1, nextAt: 6, remaining: 3 });
    expect((await card(await sit())).surprise.remaining).toBe(3);
  });

  it('CA-046-14 — une visite sous le minimum ne donne pas de tampon, et le téléphone le sait', async () => {
    const { program, card, coca, garba, owner, table, visit } = await shop('Surprise pas de tampon');
    await program({ stampsRequired: 5, rewardItemId: garba });
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({}).expect(200);
    const small = await openSession(t, table.code);
    await t.http.post('/api/v1/guest/loyalty/attach').set(small.headers).send({}).expect(200);
    const id = (await t.http.post('/api/v1/guest/orders').set(small.headers).send({ items: [{ menuItemId: coca, quantity: 1 }] }).expect(200)).body.request.id as string;
    await act(id, 'prepare');
    await act(id, 'resolve');
    await act(id, 'settle');
    expect(await card(small)).toMatchObject({ visitStamped: false, minOrderMinor: 2000, stamps: 0 });
    const big = await visit();
    expect((await card(big)).visitStamped).toBe(true);
  });

  it('CA-046-12 — un compte Essentiel ne passe pas en mode Surprise', async () => {
    const { prize, program, owner } = await shop('Surprise formule');
    await prize({ kind: 'free', name: 'Bonbons', weight: 10 });
    await t.prisma.tenant.updateMany({ where: { users: { some: { id: owner.userId } } }, data: { plan: 'essentiel' } });
    expect((await program({ mode: 'surprise', surpriseMin: 2, surpriseMax: 5 }, 403)).body.code).toBe('PLAN_FEATURE_LOCKED');
    expect((await t.http.post(`${owner.base}/loyalty/prizes`).set(owner.auth).send({ kind: 'free', name: 'Bonbons', weight: 10 }).expect(403)).body.code).toBe('PLAN_FEATURE_LOCKED');
  });
});
