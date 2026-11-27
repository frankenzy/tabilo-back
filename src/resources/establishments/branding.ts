/**
 * Spec 031, R2 : palette fermée de la couleur principale. Chaque teinte garde 4,5:1 avec le texte blanc
 * et reste nettement différente des couleurs d'état ; l'orange TABILO, par défaut, fait exception (4,3:1).
 * Les valeurs hexadécimales vivent côté interface (`frontend/src/constants/branding.ts`) : l'API ne stocke que la clé.
 */
export const BRAND_COLORS = ['orange', 'bordeaux', 'foret', 'chocolat', 'nuit', 'framboise', 'olive', 'prune'] as const;
export type BrandColor = (typeof BRAND_COLORS)[number];

/** Spec 031, R6. */
export const WELCOME_MAX = 80;

/** Spec 031, perf : un logo pèse 100 Ko au plus une fois réduit. */
export const LOGO_MAX_BYTES = 100 * 1024;
