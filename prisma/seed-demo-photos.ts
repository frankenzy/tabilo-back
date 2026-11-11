/**
 * Ajoute les photos de démonstration (prisma/demo-images, voir CREDITS.md) aux cartes
 * déjà en base, sans rien recréer : comptes, tables et QR codes restent intacts.
 * Seuls les articles et rubriques sans photo, dont le nom figure dans le jeu de démonstration,
 * sont complétés. Jamais en production.
 *
 *   npm run seed:demo-photos -- "Le Maquis (démo)" "DEMO"
 */
import { PrismaClient } from '@prisma/client';
import { demoPhoto } from './demo-images';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Les photos de démonstration sont interdites en production.');
  const names = process.argv.slice(2);
  if (names.length === 0) throw new Error('Indiquez le nom des établissements de démonstration à compléter.');

  const establishments = await prisma.establishment.findMany({ where: { name: { in: names } }, select: { id: true, tenantId: true, name: true } });
  for (const establishment of establishments) {
    const scoped = { tenantId: establishment.tenantId, establishmentId: establishment.id };
    let added = 0;
    const categories = await prisma.menuCategory.findMany({ where: { establishmentId: establishment.id, archivedAt: null, imageId: null } });
    for (const category of categories) {
      const data = demoPhoto(category.name);
      if (!data) continue;
      const image = await prisma.menuImage.create({ data: { ...scoped, mime: 'image/jpeg', data } });
      await prisma.menuCategory.update({ where: { id: category.id }, data: { imageId: image.id } });
      added += 1;
    }
    const items = await prisma.menuItem.findMany({ where: { establishmentId: establishment.id, archivedAt: null, imageId: null } });
    for (const item of items) {
      const data = demoPhoto(item.name);
      if (!data) continue;
      const image = await prisma.menuImage.create({ data: { ...scoped, mime: 'image/jpeg', data } });
      await prisma.menuItem.update({ where: { id: item.id }, data: { imageId: image.id } });
      added += 1;
    }
    console.log(`${establishment.name} : ${added} photo(s) ajoutée(s).`);
  }
  const missing = names.filter((name) => !establishments.some((e) => e.name === name));
  if (missing.length) console.log(`Introuvable(s) : ${missing.join(', ')}`);
}

main()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
