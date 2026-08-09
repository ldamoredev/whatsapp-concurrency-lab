import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { ExpireGapsService } from './application/expire-gaps.service';
import { SendMessageService } from './application/send-message.service';
import { DatabaseModule, PG_POOL } from './infrastructure/database/database.module';
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
 * Slice 3: envio idempotente con orden por conversacion y politica de huecos.
 *
 * Todavia no hay acks ni cleanup de envelopes (slice 4), ni health/metrics
 * (llegan con Kubernetes).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [MessagesController, StreamsController],
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
    ExpireGapsService,
  ],
})
export class AppModule {}
