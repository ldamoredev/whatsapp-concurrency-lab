import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module';
import {
  cleanupEligibleBatches,
  findCleanupViolations,
  type CleanedBatch,
} from '../infrastructure/persistence/cleanup.repository';
import { deliveryCleanups } from '../observability/metrics';

/**
 * Liberacion del trabajo de entrega.
 *
 * Este es el cuerpo del CronJob de cleanup. Hoy se invoca a mano
 * (`npm run deliveries:cleanup`) o desde los tests.
 *
 * Compite a proposito con el cleanup inmediato que dispara el ultimo ack: los dos
 * caminos pasan por la misma puerta (`cleanup_at IS NULL`) y solo uno la cruza. Esa
 * carrera es la que C4 exige forzar, no algo que haya que evitar.
 */
@Injectable()
export class CleanupDeliveriesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Limpia los batches elegibles: completos, o vencidos por TTL.
   *
   * La puerta y el DELETE van en la misma transaccion. Si estuvieran separados y el
   * proceso muriera en el medio, el batch quedaria marcado como limpio con sus
   * envelopes todavia ahi, y nadie los volveria a mirar.
   */
  async run(limit = 100): Promise<CleanedBatch[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const cleaned = await cleanupEligibleBatches(client, limit);
      await client.query('COMMIT');

      for (const batch of cleaned) {
        deliveryCleanups.inc({ reason: batch.reason });
      }
      return cleaned;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verificacion de I9 contra la base. Tiene que devolver siempre vacio.
   *
   * Es el tipo de query que `verify` va a correr despues de la carga: contar respuestas
   * 2xx no demuestra que no se hayan limpiado envelopes de mas.
   */
  async findViolations(): Promise<Array<{ messageId: string }>> {
    return findCleanupViolations(this.pool);
  }
}
