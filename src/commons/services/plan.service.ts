import { Injectable } from '@nestjs/common';
import { FEATURE_LABELS, PLANS, planWith, type PlanFeature } from '../constants/plans';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { forbidden } from '../utils/errors';

type Limit = 'establishments' | 'tablesPerEstablishment' | 'staffPerEstablishment';

/**
 * Spec 034 : contrôle des modules et des limites de la formule, côté API (R3, R4).
 * Le client à table n'est jamais concerné (R5) : seules les routes de gestion appellent ce service.
 */
@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  private async planOf(db: Pick<Tx, 'tenant'>, tenantId: string) {
    const { plan } = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true } });
    return PLANS[plan];
  }

  async hasFeature(tenantId: string, feature: PlanFeature, db: Pick<Tx, 'tenant'> = this.prisma): Promise<boolean> {
    return (await this.planOf(db, tenantId)).features.includes(feature);
  }

  /** R4 : `PLAN_FEATURE_LOCKED` si le module n'est pas compris dans la formule. */
  async assertFeature(tenantId: string, feature: PlanFeature, db: Pick<Tx, 'tenant'> = this.prisma): Promise<void> {
    const plan = await this.planOf(db, tenantId);
    if (plan.features.includes(feature)) return;
    throw forbidden('PLAN_FEATURE_LOCKED', `Module compris dans la formule ${planWith(feature).name} : ${FEATURE_LABELS[feature].charAt(0).toLowerCase()}${FEATURE_LABELS[feature].slice(1)}.`);
  }

  /**
   * R3 : `PLAN_LIMIT_REACHED` si créer un élément de plus dépasserait la limite. Les éléments archivés ne comptent pas.
   * `establishmentId` est requis pour les limites par établissement.
   */
  async assertLimit(tenantId: string, limit: Limit, establishmentId?: string, db: Tx | PrismaService = this.prisma): Promise<void> {
    const plan = await this.planOf(db, tenantId);
    const max = plan.limits[limit];
    if (max === null) return;
    let count: number;
    let label: string;
    if (limit === 'establishments') {
      count = await db.establishment.count({ where: { tenantId, archivedAt: null } });
      label = `${max} établissement${max > 1 ? 's' : ''}`;
    } else if (limit === 'tablesPerEstablishment') {
      count = await db.diningTable.count({ where: { tenantId, establishmentId, archivedAt: null } });
      label = `${max} tables`;
    } else {
      count = await db.membership.count({ where: { tenantId, establishmentId, user: { status: 'active' } } });
      label = `${max} membres d’équipe`;
    }
    if (count < max) return;
    const next = plan.key === 'essentiel' ? 'Pro' : 'Premium';
    throw forbidden('PLAN_LIMIT_REACHED', `Votre formule ${plan.name} compte ${label}. Passez à ${next} pour en ajouter.`);
  }
}
