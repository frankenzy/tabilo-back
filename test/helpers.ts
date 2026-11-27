import './test-env';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app.setup';
import { PrismaService } from '../src/commons/prisma/prisma.service';
import { OutboxService } from '../src/resources/outbox/outbox.service';

export const PASSWORD = 'Motdepasse-solide-1';
let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

export interface TestApp {
  app: NestFastifyApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaService;
  outbox: OutboxService;
  url: string;
  close: () => Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const { app } = await createApp();
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    http: request(app.getHttpServer()),
    prisma: app.get(PrismaService),
    outbox: app.get(OutboxService),
    url: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

export interface Account {
  token: string;
  email: string;
  userId: string;
  establishmentId: string;
  auth: { Authorization: string };
  base: string;
}

async function toAccount(t: TestApp, token: string, email: string): Promise<Account> {
  const auth = { Authorization: `Bearer ${token}` };
  const me = await t.http.get('/api/v1/auth/me').set(auth).expect(200);
  const establishmentId = me.body.memberships[0].establishment.id as string;
  return { token, email, userId: me.body.id, establishmentId, auth, base: `/api/v1/establishments/${establishmentId}` };
}

/** Crée un tenant complet (établissement + propriétaire) et désactive le délai entre demandes. */
export async function registerTenant(t: TestApp, name = 'Maquis'): Promise<Account> {
  const email = `${unique('owner')}@example.test`;
  const res = await t.http
    .post('/api/v1/auth/register')
    .send({
      organizationName: `${name} SARL`,
      establishmentName: name,
      firstName: 'Awa',
      lastName: 'Koné',
      email,
      password: PASSWORD,
      // Spec 041, R2.
      acceptTerms: true,
    })
    .expect(201);
  const account = await toAccount(t, res.body.accessToken, email);
  await t.http.patch(account.base).set(account.auth).send({ requestCooldownSeconds: 0 }).expect(200);
  return account;
}

export async function addStaff(t: TestApp, owner: Account, roleKey: 'manager' | 'waiter', firstName = 'Yao'): Promise<Account> {
  const roles = await t.http.get(`${owner.base}/roles`).set(owner.auth).expect(200);
  const role = (roles.body as { id: string; key: string }[]).find((r) => r.key === roleKey);
  const email = `${unique(roleKey)}@example.test`;
  await t.http
    .post(`${owner.base}/staff`)
    .set(owner.auth)
    .send({ email, firstName, lastName: 'Test', roleId: role?.id, password: PASSWORD })
    .expect(201);
  const login = await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return toAccount(t, login.body.accessToken, email);
}

export interface Floor {
  areaId: string;
  tableId: string;
  code: string;
}

export async function createTable(t: TestApp, owner: Account, label = unique('T').slice(-10)): Promise<Floor> {
  const area = await t.http.post(`${owner.base}/areas`).set(owner.auth).send({ name: unique('Zone').slice(-30) }).expect(201);
  const table = await t.http
    .post(`${owner.base}/tables`)
    .set(owner.auth)
    .send({ areaId: area.body.id, label, seats: 4 })
    .expect(201);
  const qr = await t.prisma.qrCode.findFirstOrThrow({ where: { tableId: table.body.id, status: 'active' } });
  return { areaId: area.body.id, tableId: table.body.id, code: qr.code };
}

export interface Guest {
  token: string;
  headers: { 'x-table-session': string };
  typeIds: string[];
}

export async function openSession(t: TestApp, code: string): Promise<Guest> {
  const res = await t.http.post('/api/v1/guest/sessions').send({ code }).expect(201);
  return {
    token: res.body.token,
    headers: { 'x-table-session': res.body.token },
    typeIds: (res.body.requestTypes as { id: string }[]).map((type) => type.id),
  };
}

export async function guestRequest(t: TestApp, guest: Guest, typeIndex = 0): Promise<string> {
  const res = await t.http
    .post('/api/v1/guest/requests')
    .set(guest.headers)
    .send({ requestTypeId: guest.typeIds[typeIndex] })
    .expect(200);
  return res.body.request.id as string;
}
