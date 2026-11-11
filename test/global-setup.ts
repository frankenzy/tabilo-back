import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './test-env';

/**
 * Prépare une base dédiée aux tests (jamais la base de développement) :
 * recréée à chaque exécution, puis migrée avec `prisma migrate deploy`,
 * ce qui vérifie au passage que les migrations sont reproductibles.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  if (!database.endsWith('_test')) throw new Error('La base de test doit se terminer par _test');
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  admin.search = '';
  const client = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await client.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  await client.$disconnect();
  execSync('npx prisma migrate deploy', {
    cwd: `${__dirname}/..`,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
