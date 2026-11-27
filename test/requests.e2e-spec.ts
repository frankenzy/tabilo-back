import { EscalationService } from '../src/resources/escalation/escalation.service';
import { Account, addStaff, createTable, Floor, guestRequest, openSession, registerTenant, startApp, TestApp } from './helpers';

describe('Demandes : parcours client, cycle de vie, concurrence, escalade', () => {
  let t: TestApp;
  let owner: Account;
  let waiter1: Account;
  let waiter2: Account;

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'La Terrasse');
    waiter1 = await addStaff(t, owner, 'waiter', 'Koffi');
    waiter2 = await addStaff(t, owner, 'waiter', 'Fatou');
  });
  afterAll(() => t.close());

  const act = (who: Account, id: string, action: string, body: object = {}) =>
    t.http.post(`${who.base}/requests/${id}/${action}`).set(who.auth).send(body);

  describe('QR codes et sessions de table', () => {
    let floor: Floor;
    beforeAll(async () => {
      floor = await createTable(t, owner);
    });

    it('refuse un QR inconnu ou mal formé, et toute demande sans session', async () => {
      await t.http.post('/api/v1/guest/sessions').send({ code: 'A'.repeat(24) }).expect(404);
      await t.http.post('/api/v1/guest/sessions').send({ code: "x' OR 1=1 --" }).expect(400);
      await t.http.get('/api/v1/guest/session').expect(401);
      await t.http.post('/api/v1/guest/requests').send({ requestTypeId: floor.tableId }).expect(401);
    });

    it('ouvre une session sans exposer de donnée interne, jeton haché en base', async () => {
      const res = await t.http.post('/api/v1/guest/sessions').send({ code: floor.code }).expect(201);
      // Specs 031, 039 et 043 : apparence, fuseau et clé de fidélité sont publics ; aucun identifiant interne.
      expect(res.body.establishment).toEqual({
        name: 'La Terrasse', currency: 'XOF', logoImageId: null, brandColor: 'orange', welcomeText: null, timezone: 'Africa/Abidjan',
        key: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(res.body.requestTypes.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toContain(owner.establishmentId);
      const stored = await t.prisma.tableSession.findMany({ where: { tableId: floor.tableId } });
      expect(stored.some((s) => s.tokenHash === res.body.token)).toBe(false);
    });

    it('rend la création idempotente et dédoublonne une demande déjà active', async () => {
      const guest = await openSession(t, floor.code);
      // Spec 029 : typeIds[0] est l'appel (sans texte) ; « De l'eau » est une demande de service qui accepte une précision.
      const body = { requestTypeId: guest.typeIds[1], note: '  Sans glaçons  ' };
      const key = { 'idempotency-key': 'abcdef123456' };
      const [first, second] = await Promise.all([
        t.http.post('/api/v1/guest/requests').set(guest.headers).set(key).send(body),
        t.http.post('/api/v1/guest/requests').set(guest.headers).set(key).send(body),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.request.id).toBe(first.body.request.id);
      expect([first.body.deduplicated, second.body.deduplicated].sort()).toEqual([false, true]);
      // Autre téléphone, même table, même type : la demande existante est renvoyée.
      const other = await openSession(t, floor.code);
      const dup = await t.http.post('/api/v1/guest/requests').set(other.headers).send({ requestTypeId: other.typeIds[1] }).expect(200);
      expect(dup.body.request.id).toBe(first.body.request.id);
      expect(dup.body.deduplicated).toBe(true);
      const count = await t.prisma.serviceRequest.count({ where: { tableId: floor.tableId } });
      expect(count).toBe(1);
      const saved = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id: first.body.request.id } });
      expect(saved.note).toBe('Sans glaçons');
    });

    it('plafonne les demandes actives par table et applique le délai entre deux demandes', async () => {
      const table = await createTable(t, owner);
      await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 2 }).expect(200);
      const guest = await openSession(t, table.code);
      await guestRequest(t, guest, 0);
      await guestRequest(t, guest, 1);
      const over = await t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: guest.typeIds[3] });
      expect(over.status).toBe(429);
      expect(over.body.code).toBe('TOO_MANY_ACTIVE_REQUESTS');

      await t.http.patch(owner.base).set(owner.auth).send({ maxActiveRequestsPerTable: 5, requestCooldownSeconds: 30 }).expect(200);
      const cooled = await t.http.post('/api/v1/guest/requests').set(guest.headers).send({ requestTypeId: guest.typeIds[3] });
      expect(cooled.status).toBe(429);
      expect(cooled.body.code).toBe('REQUEST_COOLDOWN');
      await t.http.patch(owner.base).set(owner.auth).send({ requestCooldownSeconds: 0 }).expect(200);
    });

    it('limite les ouvertures de session par table (QR photographié)', async () => {
      // Spec 027, R2 : 16 téléphones connectés au plus par table (un repère chacun).
      const crowded = await createTable(t, owner);
      for (let i = 0; i < 16; i += 1) await openSession(t, crowded.code);
      const full = await t.http.post('/api/v1/guest/sessions').send({ code: crowded.code });
      expect(full.status).toBe(429);
      expect(full.body.code).toBe('TOO_MANY_SESSIONS');

      // Plafond de fréquence : 20 ouvertures en 10 minutes, même si les sessions se ferment entre-temps.
      const table = await createTable(t, owner);
      for (let i = 0; i < 20; i += 1) {
        await openSession(t, table.code);
        await t.prisma.tableSession.updateMany({ where: { tableId: table.tableId, status: 'open' }, data: { status: 'closed', closedAt: new Date() } });
      }
      const res = await t.http.post('/api/v1/guest/sessions').send({ code: table.code });
      expect(res.status).toBe(429);
      expect(res.body.message).toContain('Réessayez');
    });

    it('bloque toute demande après fermeture, expiration ou révocation', async () => {
      const table = await createTable(t, owner);
      const closed = await openSession(t, table.code);
      const res = await t.http.post(`${waiter1.base}/tables/${table.tableId}/sessions/close`).set(waiter1.auth).expect(200);
      expect(res.body.closed).toBe(1);
      await t.http.post('/api/v1/guest/requests').set(closed.headers).send({ requestTypeId: closed.typeIds[0] }).expect(401);

      const expired = await openSession(t, table.code);
      await t.prisma.tableSession.updateMany({ where: { tableId: table.tableId, status: 'open' }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await t.http.get('/api/v1/guest/requests').set(expired.headers).expect(401);

      const before = await openSession(t, table.code);
      await t.http.post(`${owner.base}/tables/${table.tableId}/qr/regenerate`).set(owner.auth).expect(200);
      await t.http.get('/api/v1/guest/session').set(before.headers).expect(401);
      await t.http.post('/api/v1/guest/sessions').send({ code: table.code }).expect(404);
    });

    it('laisse le client annuler sa demande seulement tant qu’elle est en attente', async () => {
      const table = await createTable(t, owner);
      const guest = await openSession(t, table.code);
      const stranger = await openSession(t, floor.code);
      const pending = await guestRequest(t, guest, 0);
      await t.http.post(`/api/v1/guest/requests/${pending}/cancel`).set(stranger.headers).expect(404);
      await t.http.post(`/api/v1/guest/requests/${pending}/cancel`).set(guest.headers).expect(200);
      const taken = await guestRequest(t, guest, 1);
      await act(waiter1, taken, 'accept').expect(200);
      const res = await t.http.post(`/api/v1/guest/requests/${taken}/cancel`).set(guest.headers);
      expect(res.status).toBe(409);
    });
  });

  describe('cycle de vie', () => {
    let floor: Floor;
    let typeId: string;
    beforeAll(async () => {
      floor = await createTable(t, owner);
      const types = await t.http.get(`${owner.base}/request-types`).set(owner.auth).expect(200);
      typeId = types.body[0].id;
    });
    const staffRequest = async () => {
      const res = await t.http.post(`${waiter1.base}/requests`).set(waiter1.auth).send({ tableId: floor.tableId, requestTypeId: typeId }).expect(201);
      return res.body.id as string;
    };

    it('déroule le parcours nominal et historise chaque étape', async () => {
      const guest = await openSession(t, floor.code);
      const id = await guestRequest(t, guest);
      let view = await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200);
      expect(view.body[0]).toMatchObject({ id, status: 'pending', handledBy: null });

      expect((await act(waiter1, id, 'accept').expect(200)).body).toMatchObject({ status: 'accepted', assignee: { id: waiter1.userId } });
      view = await t.http.get('/api/v1/guest/requests').set(guest.headers).expect(200);
      expect(view.body[0]).toMatchObject({ status: 'accepted', handledBy: 'Koffi' });
      expect((await act(waiter1, id, 'start').expect(200)).body.status).toBe('in_progress');
      expect((await act(waiter1, id, 'resolve').expect(200)).body.status).toBe('resolved');

      const detail = await t.http.get(`${owner.base}/requests/${id}`).set(owner.auth).expect(200);
      // Spec 048 (CA-048-03) : l'historique, l'action la plus récente d'abord.
      expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
        'request.resolved', 'request.started', 'request.accepted', 'request.assigned', 'request.created',
      ]);
      expect(detail.body.events.at(-1).actorType).toBe('customer');
      expect(detail.body.events[2].actorName).toBe('Koffi Test');
      const row = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
      expect(row.assignedAt && row.acceptedAt && row.startedAt && row.resolvedAt).toBeTruthy();
      const assignment = await t.prisma.serviceAssignment.findFirstOrThrow({ where: { requestId: id } });
      expect(assignment.endedAt).not.toBeNull();
    });

    it('refuse les transitions interdites et les états terminaux', async () => {
      const id = await staffRequest();
      expect((await act(waiter1, id, 'start')).status).toBe(403); // pas encore affectée à waiter1
      expect((await act(owner, id, 'resolve')).body.code).toBe('INVALID_TRANSITION');
      expect((await act(owner, id, 'start')).body.code).toBe('INVALID_TRANSITION');
      await act(waiter1, id, 'accept').expect(200);
      expect((await act(waiter1, id, 'resolve')).status).toBe(409); // acceptée mais pas démarrée
      await act(waiter1, id, 'start').expect(200);
      expect((await act(owner, id, 'cancel')).status).toBe(409); // en cours : plus annulable
      await act(waiter1, id, 'resolve').expect(200);
      for (const action of ['accept', 'start', 'resolve', 'cancel']) {
        expect((await act(owner, id, action)).status).toBe(409);
      }
      // Le statut ne se modifie par aucune autre voie.
      await t.http.patch(`${owner.base}/requests/${id}`).set(owner.auth).send({ status: 'pending' }).expect(404);
    });

    it("n'accorde qu'une seule acceptation quand deux serveurs acceptent en même temps", async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await staffRequest();
        const [r1, r2] = await Promise.all([act(waiter1, id, 'accept'), act(waiter2, id, 'accept')]);
        expect([r1.status, r2.status].sort()).toEqual([200, 409]);
        const winner = r1.status === 200 ? waiter1 : waiter2;
        const row = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
        expect(row.assigneeId).toBe(winner.userId);
        const accepted = await t.prisma.serviceRequestEvent.count({ where: { requestId: id, type: 'request.accepted' } });
        const openAssignments = await t.prisma.serviceAssignment.count({ where: { requestId: id, endedAt: null } });
        expect({ accepted, openAssignments }).toEqual({ accepted: 1, openAssignments: 1 });
      }
    });

    it('réserve une demande à son destinataire, sauf supervision', async () => {
      const id = await staffRequest();
      await act(waiter1, id, 'accept').expect(200);
      expect((await act(waiter2, id, 'start')).status).toBe(403);
      expect((await act(waiter2, id, 'accept')).status).toBe(409);
      expect((await act(waiter2, id, 'assign', { assigneeId: waiter2.userId })).status).toBe(403);
      expect((await act(waiter2, id, 'cancel')).status).toBe(403);
      await act(owner, id, 'start').expect(200); // le propriétaire supervise
    });

    it('gère affectation, libération justifiée, réaffectation et transfert', async () => {
      const id = await staffRequest();
      expect((await act(owner, id, 'assign', { assigneeId: waiter1.userId }).expect(200)).body.status).toBe('assigned');
      expect((await act(waiter1, id, 'release', {})).status).toBe(400); // motif obligatoire
      expect((await act(owner, id, 'assign', { assigneeId: waiter2.userId })).status).toBe(422); // réaffectation sans motif
      const reassigned = await act(owner, id, 'assign', { assigneeId: waiter2.userId, reason: 'Koffi en pause' }).expect(200);
      expect(reassigned.body).toMatchObject({ status: 'assigned', assignee: { id: waiter2.userId } });
      expect((await act(waiter1, id, 'accept')).status).toBe(409);
      await act(waiter2, id, 'accept').expect(200);
      await act(waiter2, id, 'start').expect(200);
      const transferred = await act(waiter2, id, 'transfer', { assigneeId: waiter1.userId, reason: 'Fin de service' }).expect(200);
      expect(transferred.body).toMatchObject({ status: 'assigned', assignee: { id: waiter1.userId } });
      const released = await act(waiter1, id, 'release', { reason: 'Mauvaise zone' }).expect(200);
      expect(released.body).toMatchObject({ status: 'pending', assignee: null });

      const history = await t.prisma.serviceAssignment.findMany({ where: { requestId: id }, orderBy: { assignedAt: 'asc' } });
      expect(history.map((h) => h.assigneeId)).toEqual([waiter1.userId, waiter2.userId, waiter1.userId]);
      expect(history.every((h) => h.endedAt !== null)).toBe(true);
      await t.outbox.dispatchPending();
      const notified = await t.prisma.notification.findMany({ where: { requestId: id }, orderBy: { createdAt: 'asc' } });
      expect(notified.map((n) => [n.userId, n.type])).toEqual([
        [waiter1.userId, 'request.assigned'],
        [waiter2.userId, 'request.assigned'],
        [waiter1.userId, 'request.transferred'],
      ]);
    });

    it('interdit de modifier ou supprimer un événement historisé (append-only en base)', async () => {
      const event = await t.prisma.serviceRequestEvent.findFirstOrThrow();
      await expect(t.prisma.serviceRequestEvent.update({ where: { id: event.id }, data: { type: 'falsifié' } })).rejects.toThrow();
      await expect(t.prisma.serviceRequestEvent.delete({ where: { id: event.id } })).rejects.toThrow();
      const audit = await t.prisma.auditLog.findFirstOrThrow();
      await expect(t.prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow();
    });
  });

  describe('escalade, outbox et indicateurs', () => {
    it("escalade une demande en retard sans changer son statut, puis l'acquitte", async () => {
      const floor = await createTable(t, owner);
      const guest = await openSession(t, floor.code);
      const fresh = await guestRequest(t, guest, 0);
      const late = await guestRequest(t, guest, 1);
      await act(waiter1, late, 'accept').expect(200);
      await act(waiter1, late, 'start').expect(200);
      // La règle « non résolue après 15 min » s'applique à une demande en cours vieille de 20 min.
      await t.prisma.serviceRequest.update({ where: { id: late }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });

      const escalation = t.app.get(EscalationService);
      expect(await escalation.evaluate()).toBe(1);
      expect(await escalation.evaluate()).toBe(0); // idempotent
      const row = await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id: late } });
      expect(row).toMatchObject({ status: 'in_progress', escalationStatus: 'escalated' });
      expect((await t.prisma.serviceRequest.findUniqueOrThrow({ where: { id: fresh } })).escalationStatus).toBe('none');

      await t.outbox.dispatchPending();
      const alerts = await t.prisma.notification.findMany({ where: { requestId: late, type: 'request.escalated' } });
      expect(alerts.map((n) => n.userId)).toEqual([owner.userId]); // seuls les superviseurs

      expect((await act(waiter1, late, 'acknowledge-escalation')).status).toBe(403);
      const ack = await act(owner, late, 'acknowledge-escalation').expect(200);
      expect(ack.body).toMatchObject({ status: 'in_progress', escalationStatus: 'acknowledged' });
      expect((await act(owner, late, 'acknowledge-escalation')).status).toBe(409);
    });

    it('reprend les événements non diffusés et ne duplique rien au rejeu', async () => {
      await t.outbox.dispatchPending();
      expect((await t.outbox.backlog()).pending).toBe(0);
      const before = await t.prisma.notification.count();
      // Simule un arrêt brutal après validation mais avant diffusion.
      const replayed = await t.prisma.outboxEvent.updateMany({
        where: { establishmentId: owner.establishmentId, type: { in: ['request.assigned', 'request.escalated'] } },
        data: { publishedAt: null },
      });
      expect(replayed.count).toBeGreaterThan(0);
      expect((await t.outbox.backlog()).pending).toBe(replayed.count);
      expect(await t.outbox.dispatchPending()).toBe(replayed.count);
      expect((await t.outbox.backlog()).pending).toBe(0);
      expect(await t.prisma.notification.count()).toBe(before);
    });

    it('calcule des indicateurs exacts à partir des horodatages (médiane ≠ moyenne)', async () => {
      const tenant = await registerTenant(t, 'Mesures');
      const floor = await createTable(t, tenant);
      const all = await t.http.get(`${tenant.base}/request-types`).set(tenant.auth).expect(200);
      // Specs 028 et 029 : le personnel ne saisit que des demandes de service ou des appels (ni addition, ni message, ni commande).
      const types = { body: (all.body as { id: string; kind: string }[]).filter((type) => type.kind === 'service' || type.kind === 'call') };
      const base = Date.now() - 3_600_000;
      // Prises en charge en 60 s, 120 s et 600 s : médiane 120 s, moyenne 260 s.
      const accepts = [60, 120, 600];
      for (const [index, seconds] of accepts.entries()) {
        const res = await t.http.post(`${tenant.base}/requests`).set(tenant.auth)
          .send({ tableId: floor.tableId, requestTypeId: types.body[index].id, takeIt: true }).expect(201);
        const createdAt = new Date(base + index * 1000);
        await t.prisma.serviceRequest.update({
          where: { id: res.body.id },
          data: {
            createdAt,
            dueAt: new Date(createdAt.getTime() + 180_000),
            acceptedAt: new Date(createdAt.getTime() + seconds * 1000),
          },
        });
      }
      const cancelled = await t.http.post(`${tenant.base}/requests`).set(tenant.auth)
        .send({ tableId: floor.tableId, requestTypeId: types.body[2].id }).expect(201);
      await t.http.post(`${tenant.base}/requests/${cancelled.body.id}/cancel`).set(tenant.auth).send({}).expect(200);

      const report = await t.http.get(`${tenant.base}/analytics/report`)
        .query({ from: new Date(base - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })
        .set(tenant.auth).expect(200);
      expect(report.body.totals).toMatchObject({ total: 4, cancelled: 1, active: 3, resolved: 0, late: 1 });
      expect(report.body.totals.medianAcceptSeconds).toBeCloseTo(120, 0);
      expect(report.body.totals.averageAcceptSeconds).toBeCloseTo(260, 0);
      expect(report.body.byTable).toEqual([expect.objectContaining({ id: floor.tableId, total: 4, late: 1 })]);
      expect(report.body.byStaff).toEqual([expect.objectContaining({ id: tenant.userId, total: 3 })]);
      expect(report.body.series.reduce((sum: number, p: { total: number }) => sum + p.total, 0)).toBe(4);

      const live = await t.http.get(`${tenant.base}/analytics/live`).set(tenant.auth).expect(200);
      expect(live.body).toMatchObject({ pending: 0, accepted: 3, late: 0 });
      expect(live.body.staff).toEqual([expect.objectContaining({ id: tenant.userId, accepted: 3 })]);
      await t.http.get(`${tenant.base}/analytics/report`).query({ from: 'hier', to: 'demain' }).set(tenant.auth).expect(400);
    });
  });

  it('expose des sondes de santé sans authentification', async () => {
    await t.http.get('/api/v1/health/live').expect(200, { status: 'ok' });
    const ready = await t.http.get('/api/v1/health/ready').expect(200);
    expect(ready.body.database).toBe('up');
  });
});
