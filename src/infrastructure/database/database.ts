import { Pool, PoolConfig, types } from 'pg';

/**
 * `bigint` (int8) llega como string desde Postgres porque no entra en un number de
 * JavaScript. Lo dejamos asi a proposito: server_sequence y client_sequence son
 * numeros de orden y convertirlos silenciosamente a `number` perderia precision
 * justo en el dato del que depende todo el proyecto. Se parsean explicitamente
 * donde hagan falta.
 */
export const INT8_OID = 20;

/** `numeric` -> number, seguro para los conteos del laboratorio (count(*) devuelve int8). */
types.setTypeParser(INT8_OID, (value: string) => value);

export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  applicationName?: string;
}

/**
 * Pool acotado a proposito. Una base lenta tiene que producir un timeout acotado,
 * no una cola infinita de conexiones esperando (ver L3 en el alcance).
 */
export function createPool(options: DatabaseOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? 'whatsapp-concurrency-lab',
    statement_timeout: options.statementTimeoutMillis ?? 10_000,
  };

  return new Pool(config);
}

/**
 * Ejecuta `fn` dentro de una transaccion. BEGIN/COMMIT/ROLLBACK a la vista: el
 * aislamiento y los locks son el tema del proyecto, no un detalle que convenga
 * esconder detras de un decorador.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: import('pg').PoolClient) => Promise<T>,
  isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
