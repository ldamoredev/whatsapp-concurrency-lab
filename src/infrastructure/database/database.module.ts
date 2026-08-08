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
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** SIGTERM: cerrar el pool dentro del grace period, sin cortar queries en vuelo. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
