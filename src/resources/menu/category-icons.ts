/**
 * Pictogrammes de rubrique (spec 003) : liste fermée, partagée avec le frontend
 * (frontend/src/constants/menu-icons.ts). Une carte doit se parcourir sans savoir lire.
 */
export const CATEGORY_ICONS = [
  'utensils', 'soup', 'salad', 'fish', 'drumstick', 'beef', 'pizza', 'sandwich', 'hamburger', 'egg', 'croissant',
  'cup-soda', 'glass-water', 'coffee', 'beer', 'wine', 'martini', 'milk',
  'apple', 'banana', 'citrus', 'grape', 'cherry',
  'ice-cream', 'cake', 'cookie', 'donut', 'candy',
] as const;

export type CategoryIcon = (typeof CATEGORY_ICONS)[number];
