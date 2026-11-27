import * as argon2 from 'argon2';
import type { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { unprocessable } from '../../commons/utils/errors';

/** Spec 036, R7 : mot de passe d'un compte de la console. */
export const PLATFORM_PASSWORD_MIN = 14;

/**
 * Spec 036, R1 : crée un compte de la console, jamais par l'interface (commande `pnpm platform:create-admin`).
 * Sans dépendance vers les modules Nest : la commande ne charge que ce fichier.
 */
export async function createPlatformAdmin(prisma: PrismaService | Tx, email: string, name: string, password: string): Promise<string> {
  if (password.length < PLATFORM_PASSWORD_MIN) throw unprocessable('PASSWORD_TOO_SHORT', `Au moins ${PLATFORM_PASSWORD_MIN} caractères.`);
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const admin = await prisma.platformAdmin.create({ data: { email: email.trim().toLowerCase(), name, passwordHash } });
  return admin.id;
}
