import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PG_ERROR,
  closeTestPool,
  countRows,
  expectViolation,
  testPool,
  truncateAll,
} from './helpers/database';
import {
  createConversation,
  createConversationWithDevices,
  createDevice,
  joinConversation,
  type ConversationFixture,
} from './helpers/fixtures';

let fixture: ConversationFixture;

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(2);
});

afterAll(async () => {
  await closeTestPool();
});

describe('conversation_devices — una sola membresia por dispositivo', () => {
  it('RECHAZA agregar dos veces el mismo dispositivo a la conversacion', async () => {
    // Una membresia duplicada inflaria expected_count del proximo snapshot y ese
    // batch no se completaria nunca: los envelopes quedarian colgados para siempre.
    await expectViolation(
      () => joinConversation(fixture.conversationId, fixture.deviceIds[0]),
      { code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'conversation_devices_pkey' },
    );

    expect(await countRows('conversation_devices')).toBe(2);
  });

  it('CARRERA: 20 altas concurrentes del mismo dispositivo dejan una sola membresia', async () => {
    const newcomer = await createDevice();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => joinConversation(fixture.conversationId, newcomer)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows('conversation_devices')).toBe(3);
  });
});

describe('conversation_sequences — una sola autoridad de orden visible', () => {
  it('RECHAZA un segundo contador para la misma conversacion', async () => {
    // Dos filas de contador serian dos autoridades entregando el mismo
    // server_sequence a mensajes distintos. La PK garantiza que hay un unico lugar
    // donde tomar el lock al publicar.
    await expectViolation(
      () =>
        testPool().query('INSERT INTO conversation_sequences (conversation_id) VALUES ($1)', [
          fixture.conversationId,
        ]),
      { code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'conversation_sequences_pkey' },
    );
  });

  it('RECHAZA un contador que arranca antes de 1', async () => {
    const conversationId = await createConversation();

    await expectViolation(
      () =>
        testPool().query(
          'UPDATE conversation_sequences SET next_server_sequence = 0 WHERE conversation_id = $1',
          [conversationId],
        ),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'conversation_sequences_next_positive' },
    );
  });

  it('el contador se toma con FOR UPDATE: la segunda transaccion espera', async () => {
    const pool = testPool();
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      await first.query('BEGIN');
      await first.query(
        'SELECT next_server_sequence FROM conversation_sequences WHERE conversation_id = $1 FOR UPDATE',
        [fixture.conversationId],
      );

      await second.query('BEGIN');
      await second.query('SET LOCAL lock_timeout = \'300ms\'');

      // La segunda no puede leer-para-actualizar el contador hasta que la primera
      // commitee. Ese bloqueo es el que serializa la asignacion de server_sequence;
      // el lock_timeout lo vuelve observable en vez de dejar el test colgado.
      let blocked = false;
      try {
        await second.query(
          'SELECT next_server_sequence FROM conversation_sequences WHERE conversation_id = $1 FOR UPDATE',
          [fixture.conversationId],
        );
      } catch (error) {
        blocked = (error as { code?: string }).code === '55P03'; // lock_not_available
      }

      expect(blocked).toBe(true);

      await second.query('ROLLBACK');
      await first.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
  });
});

describe('device_sequences — orden del stream y politica de huecos', () => {
  it('RECHAZA dos filas de estado para el mismo (conversacion, dispositivo)', async () => {
    const pool = testPool();
    await pool.query(
      'INSERT INTO device_sequences (conversation_id, device_id) VALUES ($1, $2)',
      [fixture.conversationId, fixture.deviceIds[0]],
    );

    await expectViolation(
      () =>
        pool.query('INSERT INTO device_sequences (conversation_id, device_id) VALUES ($1, $2)', [
          fixture.conversationId,
          fixture.deviceIds[0],
        ]),
      { code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'device_sequences_pkey' },
    );
  });

  it('RECHAZA un estado de stream inventado', async () => {
    await expectViolation(
      () =>
        testPool().query(
          'INSERT INTO device_sequences (conversation_id, device_id, state) VALUES ($1, $2, $3)',
          [fixture.conversationId, fixture.deviceIds[0], 'esperando_un_poco'],
        ),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'device_sequences_state_valid' },
    );
  });

  it('RECHAZA un hueco sin deadline: seria una espera infinita', async () => {
    await expectViolation(
      () =>
        testPool().query(
          `INSERT INTO device_sequences (conversation_id, device_id, state, gap_deadline)
           VALUES ($1, $2, 'waiting_gap', NULL)`,
          [fixture.conversationId, fixture.deviceIds[0]],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'device_sequences_gap_deadline_matches_state',
      },
    );
  });

  it('RECHAZA un deadline colgando en un stream sano', async () => {
    await expectViolation(
      () =>
        testPool().query(
          `INSERT INTO device_sequences (conversation_id, device_id, state, gap_deadline)
           VALUES ($1, $2, 'ok', now() + interval '5 seconds')`,
          [fixture.conversationId, fixture.deviceIds[0]],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'device_sequences_gap_deadline_matches_state',
      },
    );
  });

  it('ACEPTA el ciclo ok -> waiting_gap -> resync_required limpiando el deadline', async () => {
    const pool = testPool();
    const [conversationId, deviceId] = [fixture.conversationId, fixture.deviceIds[0]];

    await pool.query('INSERT INTO device_sequences (conversation_id, device_id) VALUES ($1, $2)', [
      conversationId,
      deviceId,
    ]);

    await pool.query(
      `UPDATE device_sequences
          SET state = 'waiting_gap', gap_deadline = now() + interval '5 seconds'
        WHERE conversation_id = $1 AND device_id = $2`,
      [conversationId, deviceId],
    );

    // Al vencer el deadline el stream pasa a resync_required y el deadline se limpia:
    // el hueco no se salta en silencio, el cliente tiene que resincronizar.
    await pool.query(
      `UPDATE device_sequences
          SET state = 'resync_required', gap_deadline = NULL
        WHERE conversation_id = $1 AND device_id = $2`,
      [conversationId, deviceId],
    );

    const stored = await pool.query<{ state: string; gap_deadline: Date | null }>(
      'SELECT state, gap_deadline FROM device_sequences WHERE conversation_id = $1 AND device_id = $2',
      [conversationId, deviceId],
    );
    expect(stored.rows[0].state).toBe('resync_required');
    expect(stored.rows[0].gap_deadline).toBeNull();
  });

  it('RECHAZA pasar a resync_required sin limpiar el deadline', async () => {
    const pool = testPool();
    const [conversationId, deviceId] = [fixture.conversationId, fixture.deviceIds[0]];

    await pool.query(
      `INSERT INTO device_sequences (conversation_id, device_id, state, gap_deadline)
       VALUES ($1, $2, 'waiting_gap', now() + interval '5 seconds')`,
      [conversationId, deviceId],
    );

    await expectViolation(
      () =>
        pool.query(
          `UPDATE device_sequences SET state = 'resync_required'
            WHERE conversation_id = $1 AND device_id = $2`,
          [conversationId, deviceId],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'device_sequences_gap_deadline_matches_state',
      },
    );
  });
});
