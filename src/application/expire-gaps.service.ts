import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module';
import {
  expireOverdueGaps,
  type DeviceStream,
} from '../infrastructure/persistence/device-sequences.repository';
import { streamResyncRequired } from '../observability/metrics';

/**
 * Vencimiento de huecos.
 *
 * Este es el cuerpo del CronJob de expiracion. Hoy se invoca a mano
 * (`npm run gaps:expire`) o desde los tests; cuando exista el cluster va a correr
 * como CronJob, y tiene que seguir siendo exactamente esta operacion.
 *
 * Propiedades que lo hacen seguro:
 *
 * - **Idempotente.** Correrlo dos veces seguidas no cambia nada la segunda vez: la
 *   primera ya movio esas filas fuera de `waiting_gap`.
 * - **Seguro con workers concurrentes.** El `WHERE state = 'waiting_gap'` del UPDATE
 *   hace que dos barridos simultaneos no se pisen; el segundo simplemente no encuentra
 *   filas. No hace falta un lock global ni un lider.
 * - **Sin reloj propio.** La comparacion es contra `now()` de PostgreSQL. Un worker
 *   con el reloj adelantado no puede expirar huecos antes de tiempo.
 */
@Injectable()
export class ExpireGapsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Manda a `resync_required` los streams cuyo hueco vencio. Devuelve los afectados. */
  async run(): Promise<DeviceStream[]> {
    const expired = await expireOverdueGaps(this.pool);
    if (expired.length > 0) {
      streamResyncRequired.inc(expired.length);
    }
    return expired;
  }
}
