import { createTable, Guest, openSession, registerTenant, startApp, TestApp } from './helpers';

/**
 * Spec 029 — Appeler le serveur : un téléphone, un message.
 * Chaque test cite le critère couvert (specs/029-appel-serveur/spec.md).
 */
describe('Spec 029 — appel et message', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  interface TypeRow {
    id: string;
    kind: string;
    label: string;
  }

  async function shop(name: string) {
    const owner = await registerTenant(t, name);
    await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 20, maxRequestsPerSession: 200, requestCooldownSeconds: 0 }).expect(200);
    const table = await createTable(t, owner, '5');
    const types = (await t.http.get(`${owner.base}/request-types`).set(owner.auth).expect(200)).body as TypeRow[];
    const typeOf = (kind: string) => types.find((type) => type.kind === kind)!;
    const act = (id: string, action: string) => t.http.post(`${owner.base}/requests/${id}/${action}`).set(owner.auth).send({});
    const call = (guest: Guest) => t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: typeOf('call').id });
    const write = (guest: Guest, note?: string) =>
      t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: typeOf('message').id, ...(note === undefined ? {} : { note }) });
    const mine = async (guest: Guest) =>
      (await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200)).body as { id: string; note: string | null; status: string; handledBy: string | null }[];
    return { owner, table, types, typeOf, act, call, write, mine };
  }

  it('CA-029-02 — appeler d’un toucher : un seul appel pour la table', async () => {
    const { call, table, mine } = await shop('Appel commun');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    const first = await call(a).expect(200);
    const second = await call(b).expect(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(first.body.request.type.kind).toBe('call');
    // L'appel est commun : l'autre téléphone de la table le voit.
    expect((await mine(b)).map((request) => request.id)).toContain(first.body.request.id);
  });

  it('CA-029-03 — raccrocher tant que personne n’a pris l’appel, puis plus', async () => {
    const { call, act, table } = await shop('Raccrocher');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    const id = (await call(a).expect(200)).body.request.id as string;
    // Un autre téléphone de la table peut raccrocher l'appel commun.
    const hungUp = await t.http.post(`/api/v1/guest/requests/${id}/cancel`).set(b.headers).send({}).expect(200);
    expect(hungUp.body.status).toBe('cancelled');

    const again = (await call(a).expect(200)).body.request.id as string;
    await act(again, 'prepare').expect(200);
    expect((await t.http.post(`/api/v1/guest/requests/${again}/cancel`).set(a.headers).send({}).expect(409)).body.code).toBe('REQUEST_ALREADY_HANDLED');
  });

  it('CA-029-04 — message : texte obligatoire, propre à son auteur, un envoi = un message', async () => {
    const { write, table, mine } = await shop('Message');
    const a = await openSession(t, table.code);
    const b = await openSession(t, table.code);
    expect((await write(a).expect(422)).body.code).toBe('MESSAGE_REQUIRED');
    expect((await write(a, '   ').expect(422)).body.code).toBe('MESSAGE_REQUIRED');
    const first = await write(a, 'Une chaise pour bébé').expect(200);
    const second = await write(a, 'Et de la glace aussi').expect(200);
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.request.id).not.toBe(first.body.request.id);
    const own = await mine(a);
    expect(own.find((request) => request.id === first.body.request.id)?.note).toBe('Une chaise pour bébé');
    // L'autre téléphone de la table ne voit pas ce message.
    expect((await mine(b)).map((request) => request.id)).not.toContain(first.body.request.id);
  });

  it('CA-029-06 — « J’y vais » prend l’appel, « Fait » le termine', async () => {
    const { call, act, table, mine } = await shop('Jy vais');
    const guest = await openSession(t, table.code);
    const id = (await call(guest).expect(200)).body.request.id as string;
    const taken = await act(id, 'prepare').expect(200);
    expect(taken.body.status).toBe('in_progress');
    expect(taken.body.assignee).not.toBeNull();
    expect((await mine(guest)).find((request) => request.id === id)?.handledBy).toBeTruthy();
    expect((await act(id, 'resolve').expect(200)).body.status).toBe('resolved');
  });

  it('CA-029-07 — appel et message existent, ne se suppriment pas ; les autres demandes restent', async () => {
    const { owner, typeOf, types } = await shop('Types du serveur');
    expect(typeOf('call').label).toBe('Appeler un serveur');
    expect(typeOf('message').label).toBe('Message');
    expect(types.some((type) => type.label === 'Assistance' && type.kind === 'service')).toBe(true);
    for (const kind of ['call', 'message']) {
      const res = await t.http.delete(`${owner.base}/request-types/${typeOf(kind).id}`).set(owner.auth).expect(409);
      expect(res.body.code).toBe('SERVER_TYPE_REQUIRED');
    }
  });
});
