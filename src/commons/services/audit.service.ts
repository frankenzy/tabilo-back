import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  tenantId?: string | null;
  establishmentId?: string | null;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

/**
 * Journal d'audit (administration et sécurité). Append-only.
 * Ne jamais y placer de secret : ni mot de passe, ni jeton.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Écrit dans la transaction métier quand `tx` est fourni : l'audit suit le sort de l'opération. */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).auditLog.create({ data: entry });
  }

  /** Variante hors transaction qui n'interrompt jamais l'appelant (événements de sécurité). */
  async recordSafely(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: entry });
    } catch (error) {
      this.logger.error(`Écriture d'audit impossible (${entry.action})`, (error as Error).stack);
    }
  }
}
