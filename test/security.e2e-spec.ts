import { io, Socket } from 'socket.io-client';
import { Account, addStaff, createTable, guestRequest, openSession, PASSWORD, registerTenant, startApp, TestApp, unique } from './helpers';

describe('Sécurité : authentification, isolation inter-tenant, permissions', () => {
  let t: TestApp;
  let a: Account;
  let b: Account;

  beforeAll(async () => {
    t = await startApp();
    a = await registerTenant(t, 'Chez Awa');
    b = await registerTenant(t, 'Le Baobab');
  });
  afterAll(() => t.close());

  describe('authentification', () => {
    it('refuse un mot de passe trop court et les champs non déclarés (mass assignment)', async () => {
      const base = { organizationName: 'X SARL', establishmentName: 'X', firstName: 'A', lastName: 'B' };
      const weak = await t.http.post('/api/v1/auth/register').send({ ...base, email: `${unique('w')}@example.test`, password: 'court' });
      expect(weak.status).toBe(400);
      const extra = await t.http
        .post('/api/v1/auth/register')
        .send({ ...base, email: `${unique('m')}@example.test`, password: PASSWORD, tenantId: a.establishmentId, role: 'owner' });
      expect(extra.status).toBe(400);
      expect(extra.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuse une adresse e-mail déjà utilisée', async () => {
      const res = await t.http.post('/api/v1/auth/register').send({
        organizationName: 'Copie', establishmentName: 'Copie', firstName: 'A', lastName: 'B', email: a.email, password: PASSWORD,
      });
      expect(res.status).toBe(409);
    });

    it('exige un jeton valide', async () => {
      await t.http.get('/api/v1/auth/me').expect(401);
      await t.http.get('/api/v1/auth/me').set({ Authorization: 'Bearer faux.jeton.ici' }).expect(401);
      await t.http.get(`${a.base}/requests`).expect(401);
    });

    it('ne révèle pas si le compte existe et verrouille après 5 échecs', async () => {
      const victim = await registerTenant(t, 'Verrou');
      const unknown = await t.http.post('/api/v1/auth/login').send({ email: 'inconnu@example.test', password: 'x' });
      const wrong = await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: 'mauvais-mot-de-passe' });
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body.code).toBe(wrong.body.code);
      for (let i = 0; i < 4; i += 1) {
        await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: 'mauvais-mot-de-passe' }).expect(401);
      }
      const locked = await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: PASSWORD });
      expect(locked.status).toBe(401);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      const audit = await t.prisma.auditLog.count({ where: { actorId: victim.userId, action: 'security.account_locked' } });
      expect(audit).toBe(1);
    });

    it('fait tourner le refresh token et révoque la famille en cas de réutilisation', async () => {
      const login = await t.http.post('/api/v1/auth/login').send({ email: b.email, password: PASSWORD }).expect(200);
      const first = login.headers['set-cookie'][0].split(';')[0];
      expect(login.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
      expect(login.headers['set-cookie'][0]).toMatch(/SameSite=Strict/i);
      expect(login.body.refreshToken).toBeUndefined();

      const rotated = await t.http.post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
      const second = rotated.headers['set-cookie'][0].split(';')[0];
      expect(second).not.toBe(first);

      // Rejeu de l'ancien jeton : vol présumé, toute la famille tombe.
      await t.http.post('/api/v1/auth/refresh').set('Cookie', first).expect(401);
      await t.http.post('/api/v1/auth/refresh').set('Cookie', second).expect(401);
      const reuse = await t.prisma.auditLog.count({ where: { actorId: b.userId, action: 'security.refresh_token_reuse' } });
      expect(reuse).toBeGreaterThanOrEqual(1);
    });

    it('ne stocke ni mot de passe ni jeton en clair', async () => {
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      const sessions = await t.prisma.refreshSession.findMany({ where: { userId: a.userId } });
      expect(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);
    });
  });

  describe('isolation inter-tenant et IDOR', () => {
    it("répond 404 sur l'établissement d'un autre tenant, quelle que soit la route", async () => {
      const routes = ['', '/floor', '/requests', '/staff', '/roles', '/request-types', '/escalation-rules',
        '/analytics/live', '/audit-logs', '/notifications', '/qr-codes'];
      for (const route of routes) {
        const res = await t.http.get(`${b.base}${route}`).set(a.auth);
        expect({ route, status: res.status }).toEqual({ route, status: 404 });
      }
      await t.http.patch(b.base).set(a.auth).send({ name: 'Piraté' }).expect(404);
    });

    it("n'accède pas aux objets d'un autre tenant par leur identifiant", async () => {
      const floorB = await createTable(t, b);
      const guestB = await openSession(t, floorB.code);
      const requestB = await guestRequest(t, guestB);
      const typeB = guestB.typeIds[0];
      const floorA = await createTable(t, a);

      // Lecture et actions sur la demande de B via l'établissement de A.
      await t.http.get(`${a.base}/requests/${requestB}`).set(a.auth).expect(404);
      for (const action of ['accept', 'start', 'resolve', 'cancel', 'acknowledge-escalation']) {
        await t.http.post(`${a.base}/requests/${requestB}/${action}`).set(a.auth).send({}).expect(404);
      }
      // Modification de la table, de la zone et du type de B.
      await t.http.patch(`${a.base}/tables/${floorB.tableId}`).set(a.auth).send({ label: 'X' }).expect(404);
      await t.http.delete(`${a.base}/areas/${floorB.areaId}`).set(a.auth).expect(404);
      await t.http.patch(`${a.base}/request-types/${typeB}`).set(a.auth).send({ label: 'Piraté' }).expect(404);
      await t.http.post(`${a.base}/tables/${floorB.tableId}/qr/regenerate`).set(a.auth).expect(404);
      await t.http.post(`${a.base}/tables/${floorB.tableId}/sessions/close`).set(a.auth).expect(404);
      // Références croisées dans le corps de la requête.
      await t.http.post(`${a.base}/requests`).set(a.auth).send({ tableId: floorB.tableId, requestTypeId: typeB }).expect(404);
      await t.http.post(`${a.base}/tables`).set(a.auth).send({ areaId: floorB.areaId, label: 'Z9' }).expect(404);
      const mine = await t.http.get(`${a.base}/request-types`).set(a.auth).expect(200);
      await t.http.post(`${a.base}/requests`).set(a.auth).send({ tableId: floorA.tableId, requestTypeId: typeB }).expect(404);
      // Affectation à un utilisateur d'un autre tenant.
      const own = await t.http
        .post(`${a.base}/requests`).set(a.auth)
        .send({ tableId: floorA.tableId, requestTypeId: mine.body[0].id }).expect(201);
      await t.http.post(`${a.base}/requests/${own.body.id}/assign`).set(a.auth).send({ assigneeId: b.userId }).expect(422);
      await t.http.patch(`${a.base}/staff/${b.userId}`).set(a.auth).send({ status: 'disabled' }).expect(404);

      // Rien n'a bougé chez B.
      const intact = await t.http.get(`${b.base}/requests/${requestB}`).set(b.auth).expect(200);
      expect(intact.body.status).toBe('pending');
    });

    it('cloisonne listes, indicateurs et journal', async () => {
      const listA = await t.http.get(`${a.base}/requests?scope=all&pageSize=100`).set(a.auth).expect(200);
      const listB = await t.http.get(`${b.base}/requests?scope=all&pageSize=100`).set(b.auth).expect(200);
      const idsA = new Set((listA.body.items as { id: string }[]).map((r) => r.id));
      expect((listB.body.items as { id: string }[]).some((r) => idsA.has(r.id))).toBe(false);
      const [countA, countB] = await Promise.all([
        t.prisma.serviceRequest.count({ where: { establishmentId: a.establishmentId } }),
        t.prisma.serviceRequest.count({ where: { establishmentId: b.establishmentId } }),
      ]);
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const reportA = await t.http.get(`${a.base}/analytics/report`).query({ from, to }).set(a.auth).expect(200);
      const reportB = await t.http.get(`${b.base}/analytics/report`).query({ from, to }).set(b.auth).expect(200);
      expect(reportA.body.totals.total).toBe(countA);
      expect(reportB.body.totals.total).toBe(countB);
      const audit = await t.http.get(`${a.base}/audit-logs?pageSize=100`).set(a.auth).expect(200);
      const foreign = await t.prisma.auditLog.findMany({ where: { establishmentId: b.establishmentId }, select: { id: true } });
      const auditIds = new Set((audit.body.items as { id: string }[]).map((l) => l.id));
      expect(foreign.some((l) => auditIds.has(l.id))).toBe(false);
    });

    it('rejette les identifiants mal formés (pas de SQL injecté)', async () => {
      await t.http.get(`${a.base}/requests/1%27%20OR%20%271%27=%271`).set(a.auth).expect(400);
      await t.http.get(`/api/v1/establishments/not-a-uuid/requests`).set(a.auth).expect(404);
      await t.http.get(`${a.base}/requests?areaId=x%27;DROP%20TABLE`).set(a.auth).expect(400);
    });
  });

  describe('permissions', () => {
    let waiter: Account;
    let manager: Account;

    beforeAll(async () => {
      waiter = await addStaff(t, a, 'waiter', 'Koffi');
      manager = await addStaff(t, a, 'manager', 'Mariam');
    });

    it('limite le serveur aux opérations de salle', async () => {
      await t.http.get(`${waiter.base}/requests`).set(waiter.auth).expect(200);
      await t.http.get(`${waiter.base}/floor`).set(waiter.auth).expect(200);
      const denied: [string, string, object?][] = [
        ['post', '/areas', { name: 'Nouvelle' }],
        ['post', '/staff', {}],
        ['post', '/request-types', {}],
        ['post', '/escalation-rules', {}],
        ['post', '/roles', {}],
        ['patch', '', { name: 'Autre nom' }],
        ['get', '/analytics/live'],
        ['get', '/audit-logs'],
        ['get', '/qr-codes'],
      ];
      for (const [method, route, body] of denied) {
        const call = method === 'get' ? t.http.get(`${waiter.base}${route}`) : method === 'post'
          ? t.http.post(`${waiter.base}${route}`).send(body) : t.http.patch(`${waiter.base}${route}`).send(body);
        const res = await call.set(waiter.auth);
        expect({ route, status: res.status }).toEqual({ route, status: 403 });
      }
      const logged = await t.prisma.auditLog.count({ where: { actorId: waiter.userId, action: 'security.permission_denied' } });
      expect(logged).toBe(denied.length);
    });

    it("empêche l'escalade de privilèges", async () => {
      const roles = await t.http.get(`${manager.base}/roles`).set(manager.auth).expect(200);
      const ownerRole = (roles.body as { id: string; key: string }[]).find((r) => r.key === 'owner');
      // Un gérant ne crée pas de rôle, ne nomme pas de propriétaire, ne touche pas au propriétaire.
      await t.http.post(`${manager.base}/roles`).set(manager.auth).send({ name: 'Super', permissions: ['roles.manage'] }).expect(403);
      await t.http.patch(`${manager.base}/staff/${waiter.userId}`).set(manager.auth).send({ roleId: ownerRole?.id }).expect(403);
      await t.http.patch(`${manager.base}/staff/${a.userId}`).set(manager.auth).send({ status: 'disabled' }).expect(403);
      // Le propriétaire ne peut ni se rétrograder ni modifier un rôle système.
      await t.http.patch(`${a.base}/staff/${a.userId}`).set(a.auth).send({ status: 'disabled' }).expect(422);
      await t.http.patch(`${a.base}/roles/${ownerRole?.id}`).set(a.auth).send({ permissions: [] }).expect(403);
      await t.http.post(`${a.base}/roles`).set(a.auth).send({ name: 'Inconnu', permissions: ['tout.faire'] }).expect(422);
    });

    it('coupe immédiatement un compte désactivé', async () => {
      const temp = await addStaff(t, a, 'waiter', 'Temp');
      await t.http.get(`${temp.base}/requests`).set(temp.auth).expect(200);
      await t.http.patch(`${a.base}/staff/${temp.userId}`).set(a.auth).send({ status: 'disabled' }).expect(200);
      await t.http.get(`${temp.base}/requests`).set(temp.auth).expect(401);
      await t.http.post('/api/v1/auth/login').send({ email: temp.email, password: PASSWORD }).expect(401);
    });
  });

  describe('WebSocket', () => {
    const sockets: Socket[] = [];
    const connect = (auth: Record<string, string>) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = io(t.url, { auth, transports: ['websocket'], reconnection: false });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (error) => reject(error));
      });
    afterAll(() => sockets.forEach((s) => s.close()));

    it('refuse une connexion sans identité valide', async () => {
      await expect(connect({})).rejects.toThrow('UNAUTHORIZED');
      await expect(connect({ token: 'faux', establishmentId: a.establishmentId })).rejects.toThrow('UNAUTHORIZED');
      await expect(connect({ sessionToken: 'x'.repeat(43) })).rejects.toThrow('UNAUTHORIZED');
    });

    it("refuse l'abonnement à l'établissement d'un autre tenant", async () => {
      await expect(connect({ token: a.token, establishmentId: b.establishmentId })).rejects.toThrow('UNAUTHORIZED');
    });

    it("ne diffuse un événement qu'à son établissement et à sa table", async () => {
      const floorA = await createTable(t, a);
      const otherTableA = await createTable(t, a);
      const guestA = await openSession(t, floorA.code);
      const neighbour = await openSession(t, otherTableA.code);
      const [staffA, staffB, guestSocket, neighbourSocket] = await Promise.all([
        connect({ token: a.token, establishmentId: a.establishmentId }),
        connect({ token: b.token, establishmentId: b.establishmentId }),
        connect({ sessionToken: guestA.token }),
        connect({ sessionToken: neighbour.token }),
      ]);
      const received: Record<string, { type: string; request: Record<string, unknown> }[]> = { staffA: [], staffB: [], guest: [], neighbour: [] };
      staffA.on('request.changed', (e) => received.staffA.push(e));
      staffB.on('request.changed', (e) => received.staffB.push(e));
      guestSocket.on('request.changed', (e) => received.guest.push(e));
      neighbourSocket.on('request.changed', (e) => received.neighbour.push(e));

      const id = await guestRequest(t, guestA);
      await t.http.post(`${a.base}/requests/${id}/accept`).set(a.auth).expect(200);
      await t.outbox.dispatchPending();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received.staffA.map((e) => e.type)).toEqual(['request.created', 'request.accepted']);
      expect(received.guest.map((e) => e.type)).toEqual(['request.created', 'request.accepted']);
      expect(received.staffB).toHaveLength(0);
      expect(received.neighbour).toHaveLength(0);
      // La vue client ne contient ni note, ni nom complet, ni identifiant interne du personnel.
      const guestView = received.guest[1].request;
      expect(guestView.handledBy).toBe('Awa');
      expect(guestView).not.toHaveProperty('assignee');
      expect(guestView).not.toHaveProperty('note');
    });
  });
});
