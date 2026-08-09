import { testDatabaseOptions } from '../../src/infrastructure/database/config';
import { createPool } from '../../src/infrastructure/database/database';
import { resolveMigrationsDir } from '../../src/infrastructure/database/migrations-path';
import { migrate } from '../../src/infrastructure/database/migrator';

const MIGRATIONS_DIR = resolveMigrationsDir(__dirname);

/**
 * Migra la base de tests una sola vez, antes de todo.
 *
 * Los tests corren contra PostgreSQL real. No hay base en memoria ni mock: una
 * constraint de Postgres solo se puede probar contra Postgres.
 */
export async function setup(): Promise<void> {
  const options = testDatabaseOptions();
  const pool = createPool({ ...options, applicationName: 'whatsapp-lab-test-setup' });

  try {
    await waitForPostgres(pool, options.connectionString);
    const result = await migrate(pool, MIGRATIONS_DIR);
    const total = result.applied.length + result.skipped.length;
    console.log(
      `[setup] base de tests migrada: ${total} migracion(es), ${result.applied.length} nueva(s).`,
    );
  } finally {
    await pool.end();
  }
}

async function waitForPostgres(
  pool: import('pg').Pool,
  connectionString: string,
  attempts = 15,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === attempts) {
        const target = new URL(connectionString);
        throw new Error(
          `No se pudo conectar a la base de tests (${target.pathname.slice(1)} en ${target.host}) ` +
            `despues de ${attempts} intentos: ${(error as Error).message}\n` +
            'Levantala con:  npm run db:up',
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
