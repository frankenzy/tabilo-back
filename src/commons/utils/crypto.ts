import { createHash, randomBytes } from 'node:crypto';

/** Jeton opaque imprévisible (256 bits par défaut), encodé pour une URL. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Empreinte d'un jeton à forte entropie. SHA-256 suffit ici : contrairement à un mot de passe,
 * un jeton de 256 bits ne se devine pas par dictionnaire.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
