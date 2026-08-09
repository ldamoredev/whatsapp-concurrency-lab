import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/infrastructure/database/migrator';
import { closeTestPool, testPool } from './helpers/database';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

afterAll(async () => {
  await closeTestPool();
});

describe('runner de migraciones', () => {
  afterEach(async () => {
    // Deja el registro tal como estaba: el resto de la suite depende del schema.
    await testPool().query(
      "UPDATE schema_migrations SET checksum = checksum WHERE version = '0001'",
    );
  });

  it('es idempotente: correrlo de nuevo no aplica nada', async () => {
    // El global setup ya migro. Esta segunda corrida tiene que ser un no-op:
    // en Kubernetes el Job puede reintentarse y no puede romper el schema.
    const result = await migrate(testPool(), MIGRATIONS_DIR);

    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it('DETECTA que una migracion ya aplicada fue editada', async () => {
    const pool = testPool();
    const original = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version = '0001'",
    );

    await pool.query("UPDATE schema_migrations SET checksum = 'editada-a-mano' WHERE version = '0001'");

    try {
      await expect(migrate(pool, MIGRATIONS_DIR)).rejects.toThrow(
        /0001_conversations_devices_sequences cambio despues de aplicarse/,
      );
    } finally {
      await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'", [
        original.rows[0].checksum,
      ]);
    }
  });

  it('registro todas las migraciones del directorio', async () => {
    const applied = await testPool().query<{ version: string; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );

    expect(applied.rows.map((row) => row.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
    ]);
  });
});

describe('schema aplicado', () => {
  it('tiene las diez tablas del modelo minimo', async () => {
    const tables = await testPool().query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ORDER BY table_name`,
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'conversation_devices',
      'conversation_sequences',
      'conversations',
      'delivery_batches',
      'delivery_envelopes',
      'delivery_receipts',
      'device_sequences',
      'devices',
      'idempotency_operations',
      'messages',
    ]);
  });

  it('tiene los tres indices unicos que sostienen I1, I4 e I5', async () => {
    const indexes = await testPool().query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idempotency_operations_actor_route_key_uniq',
            'messages_stream_client_sequence_uniq',
            'messages_conversation_server_sequence_uniq'
          )
        ORDER BY indexname`,
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'idempotency_operations_actor_route_key_uniq',
      'messages_conversation_server_sequence_uniq',
      'messages_stream_client_sequence_uniq',
    ]);

    for (const row of indexes.rows) {
      expect(row.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    }

    // I5 es parcial a proposito: solo aplica a lo ya publicado.
    const i5 = indexes.rows.find(
      (row) => row.indexname === 'messages_conversation_server_sequence_uniq',
    );
    expect(i5?.indexdef).toMatch(/WHERE \(server_sequence IS NOT NULL\)/);
  });
});
