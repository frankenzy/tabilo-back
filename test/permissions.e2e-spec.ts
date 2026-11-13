import { Account, addStaff, createTable, guestRequest, openSession, registerTenant, startApp, TestApp } from './helpers';

interface StaffRow {
  id: string;
  role: { id: string; key: string };
  rolePermissions: string[];
  permissions: string[];
  revokedPermissions: string[];
}

/**
 * Spec 010 — Permissions ajustées par employé, dans les limites de son rôle.
 * Chaque test cite le critère couvert (specs/010-permissions-par-employe/spec.md).
 */
describe('Spec 010 — permissions par employé', () => {
  let t: TestApp;
  let owner: Account;

  beforeAll(async () => {
    t = await startApp();
    owner = await registerTenant(t, 'Maquis des Droits');
  });
  afterAll(() => t.close());

  const staffRow = async (who: Account) =>
    ((await t.http.get(`${owner.base}/staff`).set(owner.auth).expect(200)).body as StaffRow[]).find((row) => row.id === who.userId)!;
  const setPermissions = (actor: Account, target: Account, permissions: string[]) =>
    t.http.put(`${actor.base}/staff/${target.userId}/permissions`).set(actor.auth).send({ permissions });
  const without = (list: string[], ...removed: string[]) => list.filter((p) => !removed.includes(p));
  const me = async (who: Account) => (await t.http.get('/api/v1/auth/me').set(who.auth).expect(200)).body.memberships[0].permissions as string[];

  it('CA-010-01 — retirer « Gérer l’équipe » à une gérante coupe l’accès, sans toucher au reste', async () => {
    const mariam = await addStaff(t, owner, 'manager', 'Mariam');
    const before = await staffRow(mariam);
    const res = await setPermissions(owner, mariam, without(before.rolePermissions, 'staff.manage')).expect(200);
    expect(res.body.revokedPermissions).toEqual(['staff.manage']);
    expect(res.body.permissions).not.toContain('staff.manage');
    expect(res.body.permissions).toContain('analytics.read');

    // Effet immédiat sur l'API et sur /auth/me (menus).
    await t.http
      .post(`${mariam.base}/staff`)
      .set(mariam.auth)
      .send({ email: 'x@example.test', firstName: 'X', lastName: 'Y', roleId: before.role.id, password: 'Motdepasse-long-1' })
      .expect(403);
    await t.http.get(`${mariam.base}/analytics/live`).set(mariam.auth).expect(200);
    expect(await me(mariam)).not.toContain('staff.manage');
    const audit = await t.prisma.auditLog.count({ where: { action: 'staff.permissions_updated', entityId: mariam.userId } });
    expect(audit).toBe(1);
  });

  it('CA-010-02 — un serveur ne reçoit jamais une permission de gérant', async () => {
    const koffi = await addStaff(t, owner, 'waiter', 'Koffi');
    const row = await staffRow(koffi);
    const res = await setPermissions(owner, koffi, [...row.rolePermissions, 'analytics.read']).expect(422);
    expect(res.body.code).toBe('PERMISSION_OUTSIDE_ROLE');
    expect((await staffRow(koffi)).permissions).toEqual(row.rolePermissions);
    await t.http.get(`${koffi.base}/analytics/live`).set(koffi.auth).expect(403);
  });

  it('CA-010-03 — on n’ajuste que les permissions que l’on détient soi-même', async () => {
    const restricted = await addStaff(t, owner, 'manager', 'Awa');
    const other = await addStaff(t, owner, 'manager', 'Fatou');
    const roleOf = (await staffRow(restricted)).rolePermissions;
    await setPermissions(owner, restricted, without(roleOf, 'analytics.read')).expect(200);
    // Awa n'a plus « analytics.read » : elle ne peut pas la retirer à Fatou…
    const denied = await setPermissions(restricted, other, without(roleOf, 'analytics.read')).expect(403);
    expect(denied.body.code).toBe('PRIVILEGE_ESCALATION');
    // … mais peut ajuster une permission qu'elle détient, sans toucher à l'autre.
    await setPermissions(restricted, other, without(roleOf, 'audit.read')).expect(200);
  });

  it('CA-010-04 — ni ses propres permissions, ni celles d’un propriétaire', async () => {
    const manager = await addStaff(t, owner, 'manager', 'Serge');
    const own = (await staffRow(manager)).rolePermissions;
    const self = await setPermissions(manager, manager, without(own, 'audit.read')).expect(422);
    expect(self.body.code).toBe('SELF_CHANGE_FORBIDDEN');
    const ownerRow = await staffRow(owner);
    const protectedOwner = await setPermissions(manager, owner, without(ownerRow.rolePermissions, 'audit.read')).expect(403);
    expect(protectedOwner.body.code).toBe('OWNER_PROTECTED');
  });

  it('CA-010-05 — une permission ajoutée au rôle est donnée, sauf si elle a été retirée', async () => {
    const role = await t.http
      .post(`${owner.base}/roles`)
      .set(owner.auth)
      .send({ name: 'Chef de salle', permissions: ['requests.read', 'requests.handle', 'audit.read'] })
      .expect(201);
    const email = `chef-${Date.now()}@example.test`;
    const created = await t.http
      .post(`${owner.base}/staff`)
      .set(owner.auth)
      .send({ email, firstName: 'Chef', lastName: 'Salle', roleId: role.body.id, password: 'Motdepasse-long-1' })
      .expect(201);
    const chef = { ...owner, userId: created.body.id as string };
    await setPermissions(owner, chef, ['requests.read', 'requests.handle']).expect(200);
    await t.http
      .patch(`${owner.base}/roles/${role.body.id}`)
      .set(owner.auth)
      .send({ permissions: ['requests.read', 'requests.handle', 'audit.read', 'analytics.read'] })
      .expect(200);
    const row = await staffRow(chef);
    expect(row.permissions).toContain('analytics.read');
    expect(row.permissions).not.toContain('audit.read');
  });

  it('CA-010-06 — changer de rôle efface les retraits', async () => {
    const mariam = await addStaff(t, owner, 'manager', 'Mariam');
    const roleOf = (await staffRow(mariam)).rolePermissions;
    await setPermissions(owner, mariam, without(roleOf, 'staff.manage', 'audit.read')).expect(200);
    const roles = (await t.http.get(`${owner.base}/roles`).set(owner.auth).expect(200)).body as { id: string; key: string; permissions: string[] }[];
    const waiterRole = roles.find((r) => r.key === 'waiter')!;
    await t.http.patch(`${owner.base}/staff/${mariam.userId}`).set(owner.auth).send({ roleId: waiterRole.id }).expect(200);
    const row = await staffRow(mariam);
    expect(row.revokedPermissions).toEqual([]);
    expect([...row.permissions].sort()).toEqual([...waiterRole.permissions].sort());
  });

  it('CA-010-07 — sans « traiter les demandes », on ne reçoit plus de demande et on quitte « Qui traite quoi »', async () => {
    const koffi = await addStaff(t, owner, 'waiter', 'Koffi');
    const roleOf = (await staffRow(koffi)).rolePermissions;
    await setPermissions(owner, koffi, without(roleOf, 'requests.handle')).expect(200);
    const table = await createTable(t, owner, 'P1');
    const guest = await openSession(t, table.code);
    const requestId = await guestRequest(t, guest);
    const refused = await t.http.post(`${owner.base}/requests/${requestId}/assign`).set(owner.auth).send({ assigneeId: koffi.userId }).expect(422);
    expect(refused.body.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const live = await t.http.get(`${owner.base}/analytics/live`).set(owner.auth).expect(200);
    expect((live.body.staff as { id: string }[]).some((member) => member.id === koffi.userId)).toBe(false);
  });
});
