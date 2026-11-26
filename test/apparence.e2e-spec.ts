import { addStaff, createTable, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 031 — Apparence de l'établissement : logo, couleur et mot d'accueil.
 * Chaque test cite le critère couvert (specs/031-apparence-etablissement/spec.md).
 */
describe('Spec 031 — apparence de l’établissement', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  const jpeg = (size = 2_000) => {
    const bytes = Buffer.alloc(size, 0);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes.toString('base64');
  };
  const guestContext = async (code: string) => {
    const guest = await openSession(t, code);
    return (await t.http.get('/api/v1/guest/session').set(guest.headers).expect(200)).body.establishment as {
      name: string;
      logoImageId: string | null;
      brandColor: string;
      welcomeText: string | null;
    };
  };

  it('CA-031-01 — par défaut : pas de logo, orange TABILO, pas de mot d’accueil', async () => {
    const owner = await registerTenant(t, 'Apparence défaut');
    const settings = await t.http.get(owner.base).set(owner.auth).expect(200);
    expect(settings.body).toMatchObject({ logoImageId: null, brandColor: 'orange', welcomeText: null });
    const table = await createTable(t, owner, '1');
    expect(await guestContext(table.code)).toMatchObject({ logoImageId: null, brandColor: 'orange', welcomeText: null });
  });

  it('CA-031-02 — ajouter un logo : visible du client et du sélecteur ; un fichier non image est refusé', async () => {
    const owner = await registerTenant(t, 'Apparence logo');
    const res = await t.http.put(`${owner.base}/logo`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
    const logoId = res.body.logoImageId as string;
    expect(logoId).toBeTruthy();
    await t.http.get(`/api/v1/guest/menu-images/${logoId}`).expect(200);
    const table = await createTable(t, owner, '2');
    expect((await guestContext(table.code)).logoImageId).toBe(logoId);
    const me = await t.http.get('/api/v1/auth/me').set(owner.auth).expect(200);
    expect(me.body.memberships[0].establishment.logoImageId).toBe(logoId);
    const pdf = Buffer.from('%PDF-1.4 faux document').toString('base64');
    expect((await t.http.put(`${owner.base}/logo`).set(owner.auth).send({ mime: 'image/jpeg', data: pdf }).expect(422)).body.code).toBe('IMAGE_INVALID');
    // 100 Ko au plus (exigence de performance).
    expect((await t.http.put(`${owner.base}/logo`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg(150_000) }).expect(422)).body.code).toBe('IMAGE_TOO_LARGE');
    // Remplacer le logo supprime l'ancienne image.
    const replaced = await t.http.put(`${owner.base}/logo`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
    expect(replaced.body.logoImageId).not.toBe(logoId);
    expect(await t.prisma.menuImage.findUnique({ where: { id: logoId } })).toBeNull();
    const logs = await t.prisma.auditLog.count({ where: { establishmentId: owner.establishmentId, action: 'establishment.logo_updated' } });
    expect(logs).toBe(2);
  });

  it('CA-031-03 — choisir une couleur de la palette ; une couleur hors palette est refusée', async () => {
    const owner = await registerTenant(t, 'Apparence couleur');
    await t.http.patch(owner.base).set(owner.auth).send({ brandColor: 'foret' }).expect(200);
    const table = await createTable(t, owner, '3');
    expect((await guestContext(table.code)).brandColor).toBe('foret');
    await t.http.patch(owner.base).set(owner.auth).send({ brandColor: '#00ff00' }).expect(400);
  });

  it('CA-031-05 — mot d’accueil visible du client ; plus de 80 caractères refusé ; vide le retire', async () => {
    const owner = await registerTenant(t, 'Apparence accueil');
    await t.http.patch(owner.base).set(owner.auth).send({ welcomeText: '  Bienvenue chez Tantie Awa  ' }).expect(200);
    const table = await createTable(t, owner, '4');
    expect((await guestContext(table.code)).welcomeText).toBe('Bienvenue chez Tantie Awa');
    await t.http.patch(owner.base).set(owner.auth).send({ welcomeText: 'x'.repeat(81) }).expect(400);
    const cleared = await t.http.patch(owner.base).set(owner.auth).send({ welcomeText: '' }).expect(200);
    expect(cleared.body.welcomeText).toBeNull();
  });

  it('CA-031-08 — permissions et cloisonnement', async () => {
    const owner = await registerTenant(t, 'Apparence droits');
    const waiter = await addStaff(t, owner, 'waiter');
    await t.http.patch(waiter.base).set(waiter.auth).send({ brandColor: 'prune' }).expect(403);
    await t.http.put(`${waiter.base}/logo`).set(waiter.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(403);
    const other = await registerTenant(t, 'Apparence voisin');
    await t.http.patch(owner.base).set(other.auth).send({ brandColor: 'prune' }).expect(404);
    await t.http.put(`${owner.base}/logo`).set(other.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(404);
  });

  it('CA-031-09 — revenir au départ : sans logo, orange', async () => {
    const owner = await registerTenant(t, 'Apparence retour');
    const logo = await t.http.put(`${owner.base}/logo`).set(owner.auth).send({ mime: 'image/jpeg', data: jpeg() }).expect(200);
    await t.http.patch(owner.base).set(owner.auth).send({ brandColor: 'bordeaux' }).expect(200);
    const removed = await t.http.delete(`${owner.base}/logo`).set(owner.auth).expect(200);
    expect(removed.body.logoImageId).toBeNull();
    expect(await t.prisma.menuImage.findUnique({ where: { id: logo.body.logoImageId } })).toBeNull();
    const reset = await t.http.patch(owner.base).set(owner.auth).send({ brandColor: 'orange' }).expect(200);
    expect(reset.body).toMatchObject({ logoImageId: null, brandColor: 'orange' });
  });
});
