import type { Pool, PoolClient } from 'pg';
import { DatabaseError } from 'pg';
import { expect } from 'vitest';
import { testDatabaseOptions } from '../../../src/infrastructure/database/config';
import { createPool } from '../../../src/infrastructure/database/database';

/** Codigos SQLSTATE que este slice usa como evidencia. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
} as const;

let sharedPool: Pool | undefined;

export function testPool(): Pool {
  if (!sharedPool) {
    sharedPool = createPool(testDatabaseOptions());
  }
  return sharedPool;
}

export async function closeTestPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

/**
 * Vacia el estado entre tests.
 *
 * TRUNCATE ... CASCADE en una sola sentencia: hacerlo tabla por tabla obligaria a
 * respetar el orden de las FKs, y ese orden cambia cada vez que se agrega una.
 * `schema_migrations` queda afuera a proposito: el schema se migra una sola vez, en
 * el global setup.
 */
export async function truncateAll(pool: Pool = testPool()): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      delivery_receipts,
      delivery_envelopes,
      delivery_batches,
      messages,
      idempotency_operations,
      device_sequences,
      conversation_sequences,
      conversation_devices,
      devices,
      conversations
    RESTART IDENTITY CASCADE
  `);
}

export interface ExpectedViolation {
  /** SQLSTATE esperado. */
  code: string;
  /** Nombre exacto de la constraint o del indice unico que tiene que fallar. */
  constraint: string;
}

/**
 * Ejecuta `operation` y exige que Postgres la rechace con una violacion concreta.
 *
 * Verificar el nombre de la constraint, y no solo que "algo fallo", es lo que hace
 * util al test: si manana alguien borra el indice unico de I5 y el INSERT empieza a
 * fallar por otro motivo — o deja de fallar — el test lo dice con precision.
 */
export async function expectViolation(
  operation: () => Promise<unknown>,
  expected: ExpectedViolation,
): Promise<DatabaseError> {
  let caught: unknown;

  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(
      `Se esperaba una violacion de "${expected.constraint}" (${expected.code}) pero la operacion tuvo exito. ` +
        'La constraint no esta protegiendo la invariante.',
    );
  }

  if (!(caught instanceof DatabaseError)) {
    throw caught;
  }

  expect(
    { code: caught.code, constraint: caught.constraint },
    `mensaje de Postgres: ${caught.message}`,
  ).toEqual({ code: expected.code, constraint: expected.constraint });

  return caught;
}

/** Cuenta filas de una tabla. Los tests de invariantes miran la base, no la respuesta. */
export async function countRows(table: string, pool: Pool = testPool()): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number.parseInt(result.rows[0].count, 10);
}

/** Abre una transaccion sobre un client dedicado, para tests que necesitan dos sesiones. */
export async function beginClient(pool: Pool = testPool()): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  return client;
}

export async function rollbackClient(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
  client.release();
}
