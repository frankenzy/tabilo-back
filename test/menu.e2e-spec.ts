import { io, Socket } from 'socket.io-client';
import { Account, addStaff, createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 001 — Carte de l'établissement et commande depuis la table.
 * Chaque test cite le critère d'acceptation qu'il couvre (specs/001-menu-commandes/spec.md).
 */
describe('Spec 001 — carte et commandes', () => {
  let t: TestApp;
  let owner: Account;
  let waiter: Account;

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'Chez Tantie');
    waiter = await addStaff(t, owner, 'waiter', 'Koffi');
  });
  afterAll(() => t.close());

  const menu = (who: Account) => `${who.base}/menu`;
  const jpeg = (size = 2_000) => {
    const bytes = Buffer.alloc(size, 0);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes.toString('base64');
  };

  async function category(who: Account, name: string): Promise<string> {
    const res = await t.http.post(`${menu(who)}/categories`).set(who.auth).send({ name }).expect(201);
    return res.body.id as string;
  }

  async function item(who: Account, categoryId: string, name: string, priceMinor: number, extra: object = {}): Promise<string> {
    const res = await t.http.post(`${menu(who)}/items`).set(who.auth).send({ categoryId, name, priceMinor, ...extra }).expect(201);
    return res.body.id as string;
  }

  const order = (guest: Guest, items: { menuItemId: string; quantity: number }[], extra: { note?: string; key?: string } = {}) => {
    const req = t.http.post('/api/v1/guest/orders').set(guest.headers);
    if (extra.key) req.set('idempotency-key', extra.key);
    return req.send({ items, ...(extra.note ? { note: extra.note } : {}) });
  };

  const act = (who: Account, id: string, action: string) => t.http.post(`${who.base}/requests/${id}/${action}`).set(who.auth).send({});

  async function serve(who: Account, id: string): Promise<void> {
    await act(who, id, 'accept').expect(200);
    await act(who, id, 'start').expect(200);
    await act(who, id, 'resolve').expect(200);
  }

  async function orderTypeId(who: Account): Promise<string> {
    const types = await t.http.get(`${who.base}/request-types`).set(who.auth).expect(200);
    return (types.body as { id: string; kind: string }[]).find((type) => type.kind === 'order')!.id;
  }

  // ---------------------------------------------------------------- gestion

  describe('Gestion de la carte', () => {
    it('CA-001-01 — crée une rubrique en dernière position, vide, et l’inscrit au journal', async () => {
      const first = await category(owner, 'Entrées');
      const second = await category(owner, 'Boissons');
      const res = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      const ids = (res.body as { id: string; items: unknown[] }[]).map((c) => c.id);
      expect(ids.indexOf(second)).toBe(ids.indexOf(first) + 1);
      expect(ids[ids.length - 1]).toBe(second);
      const audit = await t.prisma.auditLog.count({ where: { action: 'menu_category.created', entityId: second } });
      expect(audit).toBe(1);
    });

    it('CA-001-02 — refuse un nom de rubrique déjà pris, sans tenir compte de la casse', async () => {
      await category(owner, 'Glaces');
      const res = await t.http.post(`${menu(owner)}/categories`).set(owner.auth).send({ name: 'glaces' }).expect(409);
      expect(res.body.code).toBe('MENU_CATEGORY_EXISTS');
    });

    it('CA-001-03 — crée un article disponible, en dernier dans sa rubrique', async () => {
      const plats = await category(owner, 'Plats du jour');
      await item(owner, plats, 'Alloco', 1000);
      const garba = await item(owner, plats, 'Garba', 1500);
      const res = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      const items = (res.body as { id: string; items: { id: string; priceMinor: number; isAvailable: boolean }[] }[])
        .find((c) => c.id === plats)!.items;
      expect(items[items.length - 1]).toMatchObject({ id: garba, priceMinor: 1500, isAvailable: true });
    });

    it('CA-001-04 — un changement de prix ne touche pas les commandes passées et est signalé à l’audit', async () => {
      const rubric = await category(owner, 'Grillades');
      const brochette = await item(owner, rubric, 'Brochettes', 1500);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const placed = await order(guest, [{ menuItemId: brochette, quantity: 2 }]).expect(200);

      await t.http.patch(`${menu(owner)}/items/${brochette}`).set(owner.auth).send({ priceMinor: 2000 }).expect(200);

      const lines = await t.prisma.serviceRequestItem.findMany({ where: { requestId: placed.body.request.id } });
      expect(lines).toEqual([expect.objectContaining({ unitPriceMinor: 1500, quantity: 2 })]);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'menu_item.updated', entityId: brochette } });
      expect(audit.metadata).toEqual({ priceChanged: true });
      // Les lignes de commande sont figées en base.
      await expect(t.prisma.serviceRequestItem.update({ where: { id: lines[0].id }, data: { quantity: 9 } })).rejects.toThrow();
    });

    it('CA-001-06 — archiver une rubrique retire ses articles de la carte, les commandes restent intactes', async () => {
      const rubric = await category(owner, 'Éphémère');
      const dish = await item(owner, rubric, 'Plat éphémère', 2500);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const placed = await order(guest, [{ menuItemId: dish, quantity: 1 }]).expect(200);

      await t.http.delete(`${menu(owner)}/categories/${rubric}`).set(owner.auth).expect(204);

      const staffMenu = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      expect(JSON.stringify(staffMenu.body)).not.toContain(dish);
      const guestMenu = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      expect(JSON.stringify(guestMenu.body.menu)).not.toContain(dish);
      const kept = await t.http.get(`${owner.base}/requests/${placed.body.request.id}`).set(owner.auth).expect(200);
      expect(kept.body.items).toEqual([{ name: 'Plat éphémère', quantity: 1, unitPriceMinor: 2500 }]);
    });

    it('CA-001-07 — ajoute une photo puis la remplace, l’ancienne est supprimée ; le retrait est audité', async () => {
      const rubric = await category(owner, 'Photos');
      const dish = await item(owner, rubric, 'Poulet DG', 4000);
      const first = await t.http.put(`${menu(owner)}/items/${dish}/image`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg(200_000) }).expect(200);
      const second = await t.http.put(`${menu(owner)}/items/${dish}/image`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
      expect(second.body.imageId).not.toBe(first.body.imageId);
      expect(await t.prisma.menuImage.findUnique({ where: { id: first.body.imageId } })).toBeNull();

      // T08 — servie publiquement, en cache long, sans reniflage de type.
      const image = await t.http.get(`/api/v1/guest/menu-images/${second.body.imageId}`).expect(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      expect(image.headers['cache-control']).toContain('immutable');
      expect(image.headers['x-content-type-options']).toBe('nosniff');
      expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');

      await t.http.delete(`${menu(owner)}/items/${dish}/image`).set(owner.auth).expect(200);
      expect(await t.prisma.menuImage.findUnique({ where: { id: second.body.imageId } })).toBeNull();
      expect(await t.prisma.auditLog.count({ where: { action: 'menu_item.image_removed', entityId: dish } })).toBe(1);
    });

    it('CA-001-07 et CA-001-27 — le navigateur est autorisé à envoyer un PUT (photo, ordre) depuis le frontend', async () => {
      const preflight = await t.http
        .options(`${menu(owner)}/categories/order`)
        .set('Origin', 'http://localhost:3004')
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    });

    it('CA-001-08 — refuse une photo trop lourde, un faux JPEG ou un format non pris en charge', async () => {
      const rubric = await category(owner, 'Photos refusées');
      const dish = await item(owner, rubric, 'Foutou', 3000);
      const url = `${menu(owner)}/items/${dish}/image`;
      const tooLarge = await t.http.put(url).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg(301 * 1024) }).expect(422);
      expect(tooLarge.body.code).toBe('IMAGE_TOO_LARGE');
      const pdf = Buffer.from('%PDF-1.4 faux document').toString('base64');
      const fake = await t.http.put(url).set(owner.auth).send({ mime: 'image/jpeg', data: pdf }).expect(422);
      expect(fake.body.code).toBe('IMAGE_INVALID');
      await t.http.put(url).set(owner.auth).send({ mime: 'image/gif', data: jpeg() }).expect(400);
    });

    it('CA-001-09 — un serveur lit la carte mais ne peut rien y modifier', async () => {
      const rubric = await category(owner, 'Réservé');
      const dish = await item(owner, rubric, 'Placali', 2000);
      await t.http.get(menu(waiter)).set(waiter.auth).expect(200);
      await t.http.post(`${menu(waiter)}/categories`).set(waiter.auth).send({ name: 'Pirate' }).expect(403);
      await t.http.patch(`${menu(waiter)}/categories/${rubric}`).set(waiter.auth).send({ name: 'Pirate' }).expect(403);
      await t.http.delete(`${menu(waiter)}/categories/${rubric}`).set(waiter.auth).expect(403);
      await t.http.post(`${menu(waiter)}/items`).set(waiter.auth).send({ categoryId: rubric, name: 'X', priceMinor: 1 }).expect(403);
      await t.http.patch(`${menu(waiter)}/items/${dish}`).set(waiter.auth).send({ priceMinor: 1 }).expect(403);
      await t.http.delete(`${menu(waiter)}/items/${dish}`).set(waiter.auth).expect(403);
      await t.http.put(`${menu(waiter)}/items/${dish}/image`).set(waiter.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(403);
      await t.http.put(`${menu(waiter)}/categories/order`).set(waiter.auth).send({ ids: [rubric] }).expect(403);
    });

    it('CA-001-10 — un autre établissement ne voit ni ne modifie rien de cette carte', async () => {
      const rubric = await category(owner, 'Secret');
      const dish = await item(owner, rubric, 'Recette maison', 3000);
      const intruder = await registerTenant(t, 'Intrus');
      const base = menu(intruder);
      const list = await t.http.get(base).set(intruder.auth).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(rubric);
      await t.http.patch(`${base}/categories/${rubric}`).set(intruder.auth).send({ name: 'Volé' }).expect(404);
      await t.http.delete(`${base}/categories/${rubric}`).set(intruder.auth).expect(404);
      await t.http.patch(`${base}/items/${dish}`).set(intruder.auth).send({ priceMinor: 1 }).expect(404);
      await t.http.delete(`${base}/items/${dish}`).set(intruder.auth).expect(404);
      await t.http.put(`${base}/items/${dish}/image`).set(intruder.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(404);
      await t.http.put(`${base}/categories/${rubric}/items/order`).set(intruder.auth).send({ ids: [dish] }).expect(404);
      const ownRubric = await category(intruder, 'Plats');
      await t.http.post(`${base}/items`).set(intruder.auth).send({ categoryId: rubric, name: 'X', priceMinor: 1 }).expect(404);
      await t.http.patch(`${base}/items/${await item(intruder, ownRubric, 'Y', 1)}`).set(intruder.auth).send({ categoryId: rubric }).expect(404);
      // Passer par l'URL de l'autre établissement : 404, comme partout (on ne confirme pas son existence).
      await t.http.get(menu(owner)).set(intruder.auth).expect(404);
      const intact = await t.prisma.menuItem.findUniqueOrThrow({ where: { id: dish } });
      expect(intact).toMatchObject({ priceMinor: 3000, archivedAt: null, categoryId: rubric });
    });

    it('CA-001-11 — la devise se choisit dans une liste fermée et parvient au client', async () => {
      const other = await registerTenant(t, 'Le Bistrot');
      await t.http.patch(other.base).set(other.auth).send({ currency: 'EUR' }).expect(200);
      await t.http.patch(other.base).set(other.auth).send({ currency: 'ABC' }).expect(400);
      const table = await createTable(t, other);
      const guest = await openSession(t, table.code);
      const context = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      expect(context.body.establishment.currency).toBe('EUR');
    });
  });

  // -------------------------------------------------- images de rubrique

  describe('Spec 003 — rubriques en images', () => {
    it('CA-003-02 — pictogramme par défaut, choisi à la création, modifiable ; hors liste refusé', async () => {
      const plain = await category(owner, 'Sans pictogramme');
      const drinks = (await t.http.post(`${menu(owner)}/categories`).set(owner.auth).send({ name: 'Jus frais', icon: 'cup-soda' }).expect(201)).body;
      expect(drinks).toMatchObject({ name: 'Jus frais', icon: 'cup-soda', imageId: null });
      await t.http.patch(`${menu(owner)}/categories/${drinks.id}`).set(owner.auth).send({ icon: 'citrus' }).expect(200);
      await t.http.post(`${menu(owner)}/categories`).set(owner.auth).send({ name: 'Fusée', icon: 'rocket' }).expect(400);
      await t.http.patch(`${menu(owner)}/categories/${plain}`).set(owner.auth).send({ icon: '<svg>' }).expect(400);
      const res = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      const byId = new Map((res.body as { id: string; icon: string }[]).map((c) => [c.id, c.icon]));
      expect(byId.get(plain)).toBe('utensils');
      expect(byId.get(drinks.id)).toBe('citrus');
    });

    it('CA-003-03 — une photo de rubrique remplace le pictogramme chez le client, auditée, contrôlée', async () => {
      const fruits = (await t.http.post(`${menu(owner)}/categories`).set(owner.auth).send({ name: 'Fruits', icon: 'apple' }).expect(201)).body.id as string;
      await item(owner, fruits, 'Ananas', 1000);
      const url = `${menu(owner)}/categories/${fruits}/image`;
      await t.http.put(url).set(waiter.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(403);
      expect((await t.http.put(url).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg(301 * 1024) }).expect(422)).body.code).toBe('IMAGE_TOO_LARGE');
      const first = await t.http.put(url).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
      const second = await t.http.put(url).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
      expect(await t.prisma.menuImage.findUnique({ where: { id: first.body.imageId } })).toBeNull();

      const guest = await openSession(t, (await createTable(t, owner)).code);
      const context = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      expect((context.body.menu as { id: string }[]).find((c) => c.id === fruits)).toMatchObject({ icon: 'apple', imageId: second.body.imageId });
      await t.http.get(`/api/v1/guest/menu-images/${second.body.imageId}`).expect(200);

      const removed = await t.http.delete(url).set(owner.auth).expect(200);
      expect(removed.body).toMatchObject({ icon: 'apple', imageId: null });
      expect(await t.prisma.auditLog.count({ where: { entityId: fruits, action: { in: ['menu_category.image_updated', 'menu_category.image_removed'] } } })).toBe(3);

      const intruder = await registerTenant(t, 'Intrus photo');
      await t.http.put(`${menu(intruder)}/categories/${fruits}/image`).set(intruder.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(404);
    });
  });

  // ----------------------------------------------------------------- ordre

  describe('Ordre de la carte', () => {
    it('CA-001-27 — réordonne les articles d’une rubrique, visible au back-office et à table', async () => {
      const rubric = await category(owner, 'Ordre');
      const garba = await item(owner, rubric, 'Garba ordre', 1500);
      const alloco = await item(owner, rubric, 'Alloco ordre', 1000);
      const attieke = await item(owner, rubric, 'Attiéké ordre', 4500);
      const res = await t.http.put(`${menu(owner)}/categories/${rubric}/items/order`).set(owner.auth).send({ ids: [attieke, garba, alloco] }).expect(200);
      expect((res.body.items as { id: string }[]).map((i) => i.id)).toEqual([attieke, garba, alloco]);

      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const context = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      const seen = (context.body.menu as { id: string; items: { id: string }[] }[]).find((c) => c.id === rubric)!;
      expect(seen.items.map((i) => i.id)).toEqual([attieke, garba, alloco]);

      // Liste incomplète, en double ou étrangère : refusée.
      const url = `${menu(owner)}/categories/${rubric}/items/order`;
      expect((await t.http.put(url).set(owner.auth).send({ ids: [attieke, garba] }).expect(422)).body.code).toBe('MENU_ORDER_MISMATCH');
      await t.http.put(url).set(owner.auth).send({ ids: [attieke, garba, garba] }).expect(422);
    });

    it('CA-001-27 — réordonne les rubriques avec la liste complète', async () => {
      const current = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      const ids = (current.body as { id: string }[]).map((c) => c.id).reverse();
      const res = await t.http.put(`${menu(owner)}/categories/order`).set(owner.auth).send({ ids }).expect(200);
      expect((res.body as { id: string }[]).map((c) => c.id)).toEqual(ids);
      await t.http.put(`${menu(owner)}/categories/order`).set(owner.auth).send({ ids: ids.slice(1) }).expect(422);
      // La position ne passe plus par le PATCH de rubrique.
      await t.http.patch(`${menu(owner)}/categories/${ids[0]}`).set(owner.auth).send({ position: 3 }).expect(400);
    });

    it('CA-001-28 — un article déplacé arrive en dernier dans sa nouvelle rubrique', async () => {
      const plats = await category(owner, 'Plats déplacement');
      const boissons = await category(owner, 'Boissons déplacement');
      const bissap = await item(owner, plats, 'Bissap', 500);
      await item(owner, plats, 'Riz sauce', 2000);
      await item(owner, boissons, 'Gnamakoudji', 500);
      await item(owner, boissons, 'Eau', 1000);
      await t.http.patch(`${menu(owner)}/items/${bissap}`).set(owner.auth).send({ categoryId: boissons }).expect(200);
      const res = await t.http.get(menu(owner)).set(owner.auth).expect(200);
      const byId = new Map((res.body as { id: string; items: { id: string }[] }[]).map((c) => [c.id, c.items.map((i) => i.id)]));
      expect(byId.get(plats)).not.toContain(bissap);
      expect(byId.get(boissons)!.at(-1)).toBe(bissap);
    });
  });

  // --------------------------------------------------------------- commande

  describe('Commande par le client', () => {
    let garba: string;
    let bissap: string;
    let rubric: string;

    beforeAll(async () => {
      rubric = await category(owner, 'Carte client');
      garba = await item(owner, rubric, 'Garba client', 1500);
      bissap = await item(owner, rubric, 'Bissap client', 500);
    });

    it('CA-001-12 — la carte s’affiche à table, rubriques vides masquées, commande ouverte', async () => {
      const empty = await category(owner, 'Rubrique vide');
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const res = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      expect(res.body.orderingEnabled).toBe(true);
      expect(res.body.establishment.currency).toBe('XOF');
      const ids = (res.body.menu as { id: string }[]).map((c) => c.id);
      expect(ids).toContain(rubric);
      expect(ids).not.toContain(empty);
      // Le type « Commande » ne figure pas parmi les demandes de service proposées.
      expect((res.body.requestTypes as { label: string }[]).map((type) => type.label)).not.toContain('Commande');
    });

    it('CA-001-13 — sans carte, ni onglet ni commande ; les demandes de service marchent', async () => {
      const bare = await registerTenant(t, 'Sans carte');
      const table = await createTable(t, bare);
      const guest = await openSession(t, table.code);
      const res = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      expect(res.body.menu).toEqual([]);
      expect(res.body.orderingEnabled).toBe(false);
      await t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: guest.typeIds[0] }).expect(200);
    });

    it('CA-001-14 — passe une commande : lignes, total, note, délai du type « Commande »', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const res = await order(guest, [{ menuItemId: garba, quantity: 2 }, { menuItemId: bissap, quantity: 1 }], { note: 'sans piment' }).expect(200);
      const created = res.body.request;
      expect(created.type.kind).toBe('order');
      expect(created.totalMinor).toBe(3500);
      expect(created.items).toEqual(
        expect.arrayContaining([
          { name: 'Garba client', quantity: 2, unitPriceMinor: 1500 },
          { name: 'Bissap client', quantity: 1, unitPriceMinor: 500 },
        ]),
      );
      const saved = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.id }, include: { requestType: true } });
      expect(saved.note).toBe('sans piment');
      expect(saved.dueAt.getTime() - saved.createdAt.getTime()).toBe(saved.requestType.slaSeconds * 1000);
    });

    it('CA-001-15 — un prix ou un nom envoyé par le client est rejeté', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      await order(guest, [{ menuItemId: garba, quantity: 1, unitPriceMinor: 1 } as never]).expect(400);
      await order(guest, [{ menuItemId: garba, quantity: 1, name: 'Gratuit' } as never]).expect(400);
      expect(await t.prisma.serviceRequest.count({ where: { tableId: table.tableId } })).toBe(0);
    });

    it('CA-001-16 — refuse en entier une commande dont un article est épuisé ou retiré', async () => {
      const kedjenou = await item(owner, rubric, 'Kedjenou client', 5000);
      const foutou = await item(owner, rubric, 'Foutou client', 3000);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);

      await t.http.patch(`${menu(owner)}/items/${kedjenou}`).set(owner.auth).send({ isAvailable: false }).expect(200);
      const out = await order(guest, [{ menuItemId: garba, quantity: 1 }, { menuItemId: kedjenou, quantity: 1 }]).expect(422);
      expect(out.body.code).toBe('MENU_ITEM_UNAVAILABLE');
      expect(out.body.message).toContain('Kedjenou client');

      await t.http.delete(`${menu(owner)}/items/${foutou}`).set(owner.auth).expect(204);
      const gone = await order(guest, [{ menuItemId: foutou, quantity: 1 }]).expect(422);
      expect(gone.body.code).toBe('MENU_ITEM_NOT_FOUND');
      expect(await t.prisma.serviceRequest.count({ where: { tableId: table.tableId } })).toBe(0);
    });

    it('CA-001-05 — un article en rupture reste visible à table, marqué indisponible', async () => {
      const dish = await item(owner, rubric, 'Sauce graine', 3500, { isAvailable: false });
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const res = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
      const seen = (res.body.menu as { items: { id: string; isAvailable: boolean }[] }[]).flatMap((c) => c.items).find((i) => i.id === dish);
      expect(seen?.isAvailable).toBe(false);
      expect((await order(guest, [{ menuItemId: dish, quantity: 1 }]).expect(422)).body.code).toBe('MENU_ITEM_UNAVAILABLE');
    });

    it('CA-001-17 — refuse un article d’un autre établissement', async () => {
      const other = await registerTenant(t, 'Concurrent');
      const otherRubric = await category(other, 'Plats');
      const foreign = await item(other, otherRubric, 'Plat étranger', 100);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      expect((await order(guest, [{ menuItemId: foreign, quantity: 1 }]).expect(422)).body.code).toBe('MENU_ITEM_NOT_FOUND');
      expect(await t.prisma.serviceRequest.count({ where: { tableId: table.tableId } })).toBe(0);
    });

    it('CA-001-18 et R14 — commande suspendue : refusée, mais la carte reste consultable', async () => {
      const typeId = await orderTypeId(owner);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      await t.http.patch(`${owner.base}/request-types/${typeId}`).set(owner.auth).send({ isActive: false }).expect(200);
      try {
        const refused = await order(guest, [{ menuItemId: garba, quantity: 1 }]).expect(422);
        expect(refused.body.code).toBe('ORDERING_DISABLED');
        expect(refused.body.message).toBe('La commande en ligne est suspendue. Adressez-vous au personnel.');
        const context = await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200);
        expect(context.body.orderingEnabled).toBe(false);
        expect(context.body.menu.length).toBeGreaterThan(0);
      } finally {
        await t.http.patch(`${owner.base}/request-types/${typeId}`).set(owner.auth).send({ isActive: true }).expect(200);
      }
    });

    it('CA-001-19 — un double envoi avec la même clé ne crée qu’une commande', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const lines = [{ menuItemId: garba, quantity: 1 }];
      const [a, b] = await Promise.all([order(guest, lines, { key: 'commande-123456' }), order(guest, lines, { key: 'commande-123456' })]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.request.id).toBe(a.body.request.id);
      expect(await t.prisma.serviceRequest.count({ where: { tableId: table.tableId } })).toBe(1);
    });

    it('CA-001-20 — plusieurs commandes coexistent sur une table, dans la limite des demandes actives', async () => {
      await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 2 }).expect(200);
      try {
        const table = await createTable(t, owner);
        const guest = await openSession(t, table.code);
        const neighbour = await openSession(t, table.code);
        const first = await order(guest, [{ menuItemId: garba, quantity: 1 }]).expect(200);
        const second = await order(neighbour, [{ menuItemId: garba, quantity: 1 }]).expect(200);
        expect(second.body.request.id).not.toBe(first.body.request.id);
        expect(second.body.deduplicated).toBe(false);
        expect((await order(guest, [{ menuItemId: bissap, quantity: 1 }]).expect(429)).body.code).toBe('TOO_MANY_ACTIVE_REQUESTS');
      } finally {
        await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 5 }).expect(200);
      }
    });

    it('CA-001-21 — refuse une commande vide, trop longue ou aux quantités hors limites', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      await order(guest, []).expect(400);
      await order(guest, Array.from({ length: 31 }, () => ({ menuItemId: garba, quantity: 1 }))).expect(400);
      await order(guest, [{ menuItemId: garba, quantity: 0 }]).expect(400);
      await order(guest, [{ menuItemId: garba, quantity: 21 }]).expect(400);
      // Lignes en double fusionnées, plafonnées à 50 par article.
      const merged = await order(guest, Array.from({ length: 3 }, () => ({ menuItemId: garba, quantity: 20 }))).expect(422);
      expect(merged.body.code).toBe('QUANTITY_TOO_HIGH');
      const ok = await order(guest, [{ menuItemId: garba, quantity: 2 }, { menuItemId: garba, quantity: 3 }]).expect(200);
      expect(ok.body.request.items).toEqual([{ name: 'Garba client', quantity: 5, unitPriceMinor: 1500 }]);
    });

    it('CA-001-26 — le client suit ses commandes avec lignes et total, sans note ni nom de famille', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const placed = await order(guest, [{ menuItemId: bissap, quantity: 2 }], { note: 'bien frais' }).expect(200);
      await act(owner, placed.body.request.id, 'accept').expect(200);
      const res = await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200);
      const seen = (res.body as Record<string, unknown>[]).find((r) => r.id === placed.body.request.id)!;
      expect(seen).toMatchObject({ totalMinor: 1000, items: [{ name: 'Bissap client', quantity: 2, unitPriceMinor: 500 }], handledBy: 'Awa' });
      expect(seen).not.toHaveProperty('note');
      expect(JSON.stringify(seen)).not.toContain('Koné');
    });
  });

  // -------------------------------------------------------------- personnel

  describe('Traitement par le personnel', () => {
    const sockets: Socket[] = [];
    afterAll(() => sockets.forEach((s) => s.close()));

    it('CA-001-22 et CA-001-23 — la commande arrive en temps réel avec ses lignes, puis suit le cycle normal', async () => {
      const rubric = await category(owner, 'Temps réel');
      const dish = await item(owner, rubric, 'Poisson braisé', 4500);
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const staff = await new Promise<Socket>((resolve, reject) => {
        const socket = io(t.url, { auth: { token: waiter.token, establishmentId: waiter.establishmentId }, transports: ['websocket'], reconnection: false });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });
      const received: { type: string; request: Record<string, unknown> }[] = [];
      staff.on('request.changed', (event) => received.push(event));

      const placed = await order(guest, [{ menuItemId: dish, quantity: 2 }], { note: 'bien cuit' }).expect(200);
      await t.outbox.dispatchPending();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const created = received.find((e) => e.type === 'request.created' && e.request.id === placed.body.request.id);
      expect(created?.request).toMatchObject({
        totalMinor: 9000,
        note: 'bien cuit',
        items: [{ name: 'Poisson braisé', quantity: 2, unitPriceMinor: 4500 }],
        type: expect.objectContaining({ kind: 'order' }),
        table: expect.objectContaining({ id: table.tableId }),
      });

      await serve(waiter, placed.body.request.id);
      const done = await t.http.get(`${waiter.base}/requests/${placed.body.request.id}`).set(waiter.auth).expect(200);
      expect(done.body.status).toBe('resolved');
    });

    it('CA-001-24 — le type « Commande » ne s’archive pas mais se renomme et se règle', async () => {
      const typeId = await orderTypeId(owner);
      const refused = await t.http.delete(`${owner.base}/request-types/${typeId}`).set(owner.auth).expect(409);
      expect(refused.body.code).toBe('ORDER_TYPE_REQUIRED');
      await t.http.patch(`${owner.base}/request-types/${typeId}`).set(owner.auth).send({ label: 'Commande à table', slaSeconds: 600 }).expect(200);
      await t.http.patch(`${owner.base}/request-types/${typeId}`).set(owner.auth).send({ label: 'Commande', slaSeconds: 300 }).expect(200);
    });

    it('CA-001-25 — tout nouvel établissement a exactement un type « Commande » actif', async () => {
      const fresh = await registerTenant(t, 'Nouveau maquis');
      const count = (establishmentId: string) =>
        t.prisma.requestType.count({ where: { establishmentId, kind: 'order', isActive: true, archivedAt: null } });
      expect(await count(fresh.establishmentId)).toBe(1);
      const second = await t.http.post('/api/v1/establishments').set(fresh.auth).send({ name: 'Nouveau maquis 2' }).expect(201);
      expect(await count(second.body.id)).toBe(1);
    });
  });

  // ------------------------------------------------------------- suggestions

  describe('Spec 002 — suggestions « Souvent commandés avec »', () => {
    let shop: Account;
    let ids: Record<string, string>;
    const suggest = (guest: Guest, items: string[] = []) =>
      t.http.get('/api/v1/guest/suggestions').query(items.length ? { items: items.join(',') } : {}).set(guest.headers);

    beforeAll(async () => {
      shop = await registerTenant(t, 'Maquis suggestions');
      const plats = await category(shop, 'Plats');
      const boissons = await category(shop, 'Boissons');
      const desserts = await category(shop, 'Desserts');
      ids = {
        garba: await item(shop, plats, 'Garba', 1500),
        alloco: await item(shop, plats, 'Alloco', 1000),
        bissap: await item(shop, boissons, 'Bissap', 500),
        eau: await item(shop, boissons, 'Eau', 1000),
        degue: await item(shop, desserts, 'Dêguê', 1000),
      };
    });

    it('CA-002-10 — sans historique : articles des rubriques absentes de la commande, dans l’ordre de la carte', async () => {
      const guest = await openSession(t, (await createTable(t, shop)).code);
      const res = await suggest(guest, [ids.garba]).expect(200);
      expect(res.body.menuItemIds).toEqual([ids.bissap, ids.eau, ids.degue]);
      // Panier vide : toute la carte, 6 au plus.
      expect((await suggest(guest).expect(200)).body.menuItemIds).toEqual([ids.garba, ids.alloco, ids.bissap, ids.eau, ids.degue]);
    });

    it('CA-002-09 — l’article le plus souvent pris avec ceux de la commande passe en tête', async () => {
      const table = await createTable(t, shop);
      // Trois commandes servies avec Garba + Bissap, une avec Garba + Dêguê, une annulée avec Garba + Eau.
      const place = async (items: string[]) => {
        const guest = await openSession(t, table.code);
        const res = await t.http.post('/api/v1/guest/orders').set(guest.headers).send({ items: items.map((menuItemId) => ({ menuItemId, quantity: 1 })) }).expect(200);
        return res.body.request.id as string;
      };
      for (const items of [[ids.garba, ids.bissap], [ids.garba, ids.bissap], [ids.garba, ids.bissap], [ids.garba, ids.degue]]) {
        await serve(shop, await place(items));
      }
      const cancelled = await place([ids.garba, ids.eau]);
      await t.http.post(`${shop.base}/requests/${cancelled}/cancel`).set(shop.auth).send({}).expect(200);

      const guest = await openSession(t, table.code);
      const res = await suggest(guest, [ids.garba]).expect(200);
      expect(res.body.menuItemIds.slice(0, 2)).toEqual([ids.bissap, ids.degue]);
      expect(res.body.menuItemIds).not.toContain(ids.garba);
      // Une fois Bissap dans la commande, il disparaît des suggestions.
      expect((await suggest(guest, [ids.garba, ids.bissap]).expect(200)).body.menuItemIds).not.toContain(ids.bissap);
    });

    it('CA-002-11 — jamais un article épuisé, retiré ou étranger ; 6 au plus ; session obligatoire', async () => {
      const guest = await openSession(t, (await createTable(t, shop)).code);
      await t.http.patch(`${menu(shop)}/items/${ids.degue}`).set(shop.auth).send({ isAvailable: false }).expect(200);
      await t.http.delete(`${menu(shop)}/items/${ids.eau}`).set(shop.auth).expect(204);
      const other = await registerTenant(t, 'Autre maquis');
      const foreign = await item(other, await category(other, 'Plats'), 'Étranger', 100);
      const res = await suggest(guest, [ids.garba, foreign]).expect(200);
      expect(res.body.menuItemIds).not.toContain(ids.degue);
      expect(res.body.menuItemIds).not.toContain(ids.eau);
      expect(res.body.menuItemIds).not.toContain(foreign);
      expect(res.body.menuItemIds.length).toBeLessThanOrEqual(6);

      await t.http.get('/api/v1/guest/suggestions').expect(401);
      await suggest(guest, ['pas-un-uuid']).expect(400);
      await suggest(guest, Array.from({ length: 31 }, () => ids.garba)).expect(400);
    });
  });

  // ------------------------------------------------------------ statistiques

  describe('Statistiques de ventes', () => {
    let shop: Account;
    const range = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

    beforeAll(async () => {
      shop = await registerTenant(t, 'Glacier');
    });

    it('CA-001-31 — sans commande, montant nul et panier moyen absent', async () => {
      const report = await t.http.get(`${shop.base}/analytics/report`).query(range()).set(shop.auth).expect(200);
      expect(report.body.sales).toEqual({ currency: 'XOF', orders: 0, amountMinor: 0, averageMinor: null, topItems: [] });
    });

    it('CA-001-29 et CA-001-30 — montant des commandes servies, panier moyen, répartitions et articles', async () => {
      const rubric = await category(shop, 'Glaces');
      const vanille = await item(shop, rubric, 'Vanille', 1500);
      const coco = await item(shop, rubric, 'Coco', 500);
      const table = await createTable(t, shop);

      const a = await order(await openSession(t, table.code), [{ menuItemId: vanille, quantity: 2 }, { menuItemId: coco, quantity: 1 }]).expect(200);
      const b = await order(await openSession(t, table.code), [{ menuItemId: vanille, quantity: 1 }]).expect(200);
      const c = await order(await openSession(t, table.code), [{ menuItemId: coco, quantity: 4 }]).expect(200);
      await serve(shop, a.body.request.id);
      await serve(shop, b.body.request.id);
      await t.http.post(`${shop.base}/requests/${c.body.request.id}/cancel`).set(shop.auth).send({}).expect(200);
      // Une demande de service n'a pas de montant.
      const caller = await openSession(t, table.code);
      const call = await t.http.post('/api/v1/guest/requests').set(caller.headers).send({ requestTypeId: caller.typeIds[0] }).expect(200);
      await serve(shop, call.body.request.id);
      // Changer le prix après coup ne réécrit pas les ventes (lignes figées).
      await t.http.patch(`${menu(shop)}/items/${vanille}`).set(shop.auth).send({ priceMinor: 9999 }).expect(200);

      const report = await t.http.get(`${shop.base}/analytics/report`).query(range()).set(shop.auth).expect(200);
      expect(report.body.sales).toMatchObject({ currency: 'XOF', orders: 2, amountMinor: 5000, averageMinor: 2500 });
      expect(report.body.sales.topItems).toEqual([
        { menuItemId: vanille, name: 'Vanille', quantity: 3, amountMinor: 4500 },
        { menuItemId: coco, name: 'Coco', quantity: 1, amountMinor: 500 },
      ]);
      const sum = (rows: { amountMinor: number }[]) => rows.reduce((total, row) => total + row.amountMinor, 0);
      expect(sum(report.body.byArea)).toBe(5000);
      expect(sum(report.body.byStaff)).toBe(5000);
      expect(sum(report.body.series)).toBe(5000);
      expect(report.body.byType.find((row: { label: string }) => row.label === 'Commande').amountMinor).toBe(5000);
    });

    it('CA-001-32 — un serveur n’a accès à aucun montant agrégé', async () => {
      await t.http.get(`${waiter.base}/analytics/report`).query(range()).set(waiter.auth).expect(403);
    });
  });
});
