import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Runner de migraciones SQL versionadas.
 *
 * Sin ORM y sin generacion automatica: el SQL del schema se escribe a mano y se lee
 * como documentacion de las invariantes. Este archivo solo lo aplica en orden, una
 * vez, y verifica que nadie haya editado una migracion ya aplicada.
 */

/** Clave arbitraria pero fija del advisory lock que serializa las migraciones. */
const MIGRATION_ADVISORY_LOCK_KEY = 8_374_610_012_345n;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export function loadMigrations(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(
        `Nombre de migracion invalido: "${file}". Formato esperado: 0001_descripcion.sql`,
      );
    }

    const sql = readFileSync(join(directory, file), 'utf8');

    return {
      version: match[1],
      name: match[2],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function getAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(pool);
  const result = await pool.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica las migraciones pendientes.
 *
 * Dos detalles que importan para el laboratorio:
 *
 * 1. Un advisory lock a nivel de sesion serializa el runner. En Kubernetes las
 *    migraciones corren como Job, pero nada impide que dos pods o dos desarrolladores
 *    lo lancen a la vez; sin el lock, dos runners leerian "pendiente" para la misma
 *    migracion y el segundo fallaria a mitad de camino con un error confuso
 *    ("relation already exists") en vez de esperar su turno.
 *
 * 2. Cada migracion corre dentro de su propia transaccion. Postgres tiene DDL
 *    transaccional, asi que una migracion que falla a la mitad no deja el schema en
 *    un estado intermedio.
 */
export async function migrate(pool: Pool, directory: string): Promise<MigrateResult> {
  const migrations = loadMigrations(directory);
  await ensureMigrationsTable(pool);

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);

    const alreadyApplied = await client.query<{ version: string; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM schema_migrations',
    );
    const byVersion = new Map(alreadyApplied.rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const previous = byVersion.get(migration.version);

      if (previous) {
        // Una migracion aplicada es historia. Editarla hace que la base de quien ya
        // migro y la de quien migra desde cero dejen de ser la misma base, y eso no
        // se descubre hasta que una constraint falta en produccion.
        if (previous.checksum !== migration.checksum) {
          throw new Error(
            `La migracion ${migration.version}_${migration.name} cambio despues de aplicarse.\n` +
              `  checksum aplicado: ${previous.checksum}\n` +
              `  checksum en disco: ${migration.checksum}\n` +
              'Las migraciones aplicadas son inmutables: escribi una nueva.',
          );
        }
        skipped.push(`${migration.version}_${migration.name}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(`${migration.version}_${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Fallo la migracion ${migration.version}_${migration.name}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()])
      .catch(() => undefined);
    client.release();
  }
}
