/**
 * Spec 036, R1 : crée un compte de la console de la plateforme. Jamais par l'interface.
 *
 *   PLATFORM_ADMIN_PASSWORD='…14 caractères au moins…' pnpm platform:create-admin admin@tabilo.ci "Francis Konan"
 *
 * Le mot de passe passe par une variable d'environnement pour ne pas rester dans l'historique du terminal.
 */
import { PrismaClient } from '@prisma/client';
import { createPlatformAdmin } from '../src/resources/platform/platform';

async function main(): Promise<void> {
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(' ').trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (!email || !name) throw new Error('Usage : PLATFORM_ADMIN_PASSWORD=… pnpm platform:create-admin <e-mail> <nom>');
  const prisma = new PrismaClient();
  try {
    const id = await createPlatformAdmin(prisma as never, email, name, password);
    console.log(`Compte plateforme créé : ${email} (${id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
