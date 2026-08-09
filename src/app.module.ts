import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { AckService } from './application/ack.service';
import { CleanupDeliveriesService } from './application/cleanup-deliveries.service';
import { ExpireGapsService } from './application/expire-gaps.service';
import { LabService } from './application/lab.service';
import { NaiveService } from './application/naive.service';
import { SendMessageService } from './application/send-message.service';
import { DatabaseModule, PG_POOL } from './infrastructure/database/database.module';
import { AcksController } from './http/acks.controller';
import { HealthController } from './http/health.controller';
import { LabController } from './http/lab.controller';
import { NaiveController } from './http/naive.controller';
import { PanelController } from './http/panel.controller';
import { MetricsController } from './http/metrics.controller';
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
 * El panel y sus endpoints se registran salvo que se apaguen explicitamente.
 *
 * `POST /lab/reset` TRUNCA todas las tablas. En este laboratorio eso es la
 * funcionalidad, no un riesgo: el panel existe para provocar carreras y volver a
 * empezar. En cualquier despliegue que no sea el lab, `LAB_PANEL_ENABLED=false`.
 */
export const LAB_PANEL_ENABLED = process.env.LAB_PANEL_ENABLED !== 'false';

/**
 * Slice 6: el dominio completo, salud, metricas y el panel de laboratorio.
 *
 * Falta Kubernetes (S7) y la carga con fallos (S8).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [
    MessagesController,
    StreamsController,
    AcksController,
    HealthController,
    MetricsController,
    ...(LAB_PANEL_ENABLED ? [LabController, NaiveController, PanelController] : []),
  ],
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
    LabService,
    NaiveService,
  ],
})
export class AppModule {}
