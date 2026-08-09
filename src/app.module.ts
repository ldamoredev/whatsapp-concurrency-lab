import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { AckService } from './application/ack.service';
import { CleanupDeliveriesService } from './application/cleanup-deliveries.service';
import { ExpireGapsService } from './application/expire-gaps.service';
import { SendMessageService } from './application/send-message.service';
import { DatabaseModule, PG_POOL } from './infrastructure/database/database.module';
import { AcksController } from './http/acks.controller';
import { MessagesController } from './http/messages.controller';
import { StreamsController } from './http/streams.controller';

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} debe ser un entero, se recibio "${raw}"`);
  return parsed;
}

/**
 * Slice 4: envio idempotente, orden por conversacion y entrega multi-dispositivo.
 *
 * Todavia no hay health/metrics ni observabilidad: llegan con Kubernetes.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [MessagesController, StreamsController, AcksController],
  providers: [
    {
      provide: SendMessageService,
      // useFactory y no @Injectable directo: el lease y el TTL son configuracion del
      // laboratorio, y los tests necesitan poder achicar el lease a milisegundos para
      // provocar el takeover de una operacion abandonada.
      useFactory: (pool: Pool) =>
        new SendMessageService(pool, {
          leaseMs: readInt('IDEMPOTENCY_LEASE_MS', 30_000),
          ttlMs: readInt('IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000),
          gapTimeoutMs: readInt('GAP_TIMEOUT_MS', 30_000),
        }),
      inject: [PG_POOL],
    },
    {
      provide: AckService,
      useFactory: (pool: Pool) =>
        new AckService(pool, {
          // El estado terminal que libera el trabajo de entrega es configuracion, y
          // esta documentado: `read` es recibo de producto, no requisito para limpiar.
          terminalState: (process.env.DELIVERY_TERMINAL_STATE as 'delivered' | 'read') ?? 'delivered',
          cleanupOnComplete: process.env.CLEANUP_ON_COMPLETE !== 'false',
        }),
      inject: [PG_POOL],
    },
    ExpireGapsService,
    CleanupDeliveriesService,
  ],
})
export class AppModule {}
