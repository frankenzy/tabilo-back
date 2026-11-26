import type { PlanKey } from '@prisma/client';

/**
 * Spec 034, R1 : catalogue des formules d'abonnement. Source de vérité unique, versionnée avec le code,
 * comme le catalogue des permissions. `null` = illimité.
 */
export type PlanFeature = 'bundles' | 'promotions' | 'yearly_stats' | 'custom_roles' | 'options' | 'exports' | 'loyalty';

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  /** Spec 034, R2 bis : prix mensuel en XOF (unité mineure = F CFA). */
  monthlyPriceMinor: number;
  limits: { establishments: number | null; tablesPerEstablishment: number | null; staffPerEstablishment: number | null };
  features: PlanFeature[];
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  essentiel: {
    key: 'essentiel',
    name: 'Essentiel',
    monthlyPriceMinor: 15_000,
    limits: { establishments: 1, tablesPerEstablishment: 15, staffPerEstablishment: 5 },
    features: [],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    monthlyPriceMinor: 35_000,
    limits: { establishments: 3, tablesPerEstablishment: 50, staffPerEstablishment: 20 },
    features: ['bundles', 'promotions', 'yearly_stats', 'custom_roles', 'options', 'exports', 'loyalty'],
  },
  premium: {
    key: 'premium',
    name: 'Premium',
    monthlyPriceMinor: 75_000,
    limits: { establishments: null, tablesPerEstablishment: null, staffPerEstablishment: null },
    features: ['bundles', 'promotions', 'yearly_stats', 'custom_roles', 'options', 'exports', 'loyalty'],
  },
};

export const PLAN_ORDER: PlanKey[] = ['essentiel', 'pro', 'premium'];

export const FEATURE_LABELS: Record<PlanFeature, string> = {
  bundles: 'Les formules (packs)',
  promotions: 'Les promotions et le geste « Offert »',
  yearly_stats: 'Les ventes de l’année',
  custom_roles: 'Les rôles personnalisés et les permissions par employé',
  options: 'Les options et suppléments des plats',
  exports: 'L’export des ventes (CSV et récapitulatif)',
  loyalty: 'La carte de fidélité',
};

/** Spec 035, R2 et R3 (décisions du porteur, 2026-11-26). */
export const TRIAL_DAYS = 7;
export const GRACE_DAYS = 7;
export const WARNING_DAYS = 7;

/** Spec 035, Q3 : WhatsApp Business de TABILO, affiché dans les bandeaux d'échéance. */
export const TABILO_WHATSAPP = '+225 05 84 77 73 67';

/** La plus petite formule qui comprend un module (pour le message « Avec Pro »). */
export function planWith(feature: PlanFeature): PlanDefinition {
  return PLAN_ORDER.map((key) => PLANS[key]).find((plan) => plan.features.includes(feature)) ?? PLANS.premium;
}
