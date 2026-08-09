import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { databaseOptions } from './config';
import { createPool } from './database';

export const PG_POOL = Symbol('PG_POOL');

/**
 * Expone el `Pool` de `pg` tal cual, sin repositorio generico ni ORM en el medio.
 *
 * Es deliberado: las transacciones, los `FOR UPDATE`, el nivel de aislamiento y los
 * codigos de error de Postgres tienen que quedar visibles en el codigo que los usa.
 * Una capa que los uniforme haria el codigo mas corto y el sistema imposible de
 * explicar.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => createPool(databaseOptions()),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  private closed = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * SIGTERM: cerrar el pool dentro del grace period, sin cortar queries en vuelo.
   *
   * El guard no es paranoia: `pool.end()` llamado dos veces lanza y tumba el proceso
   * durante el apagado, que es el peor momento para un crash — deja transacciones
   * cortadas en vez de drenadas.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }
}
