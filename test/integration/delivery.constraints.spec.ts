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
  createConversationWithDevices,
  createDevice,
  insertDeliveryBatch,
  insertEnvelope,
  insertMessage,
  insertReceipt,
  publishWithDeliveries,
  uuid,
  type ConversationFixture,
} from './helpers/fixtures';

let fixture: ConversationFixture;

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * La separacion mensaje / snapshot / trabajo / recibo es el corazon del diseno.
 * Estos son los tests que fallan si alguien la colapsa en una fila.
 */
describe('separacion entre trabajo de entrega y recibo durable', () => {
  it('el cleanup borra los envelopes y NO toca el batch ni los receipts', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const pool = testPool();

    expect(await countRows('delivery_envelopes')).toBe(3);
    expect(await countRows('delivery_receipts')).toBe(3);

    // Todos los dispositivos llegaron al estado terminal: el batch se completa y el
    // trabajo pendiente se libera.
    await pool.query(
      `UPDATE delivery_receipts
          SET state = 'delivered', delivered_at = now(), version = version + 1
        WHERE message_id = $1`,
      [messageId],
    );
    await pool.query(
      `UPDATE delivery_batches
          SET delivered_count = expected_count, completed_at = now(),
              cleanup_at = now(), cleanup_reason = 'completed'
        WHERE message_id = $1`,
      [messageId],
    );
    await pool.query('DELETE FROM delivery_envelopes WHERE message_id = $1', [messageId]);

    // El trabajo desaparecio; la evidencia no. Sin esto no se podrian auditar I7, I8
    // ni I9 despues del cleanup, que es exactamente cuando hace falta auditarlas.
    expect(await countRows('delivery_envelopes')).toBe(0);
    expect(await countRows('delivery_receipts')).toBe(3);
    expect(await countRows('delivery_batches')).toBe(1);

    const audit = await pool.query<{ expected_count: number; delivered: string }>(
      `SELECT b.expected_count,
              count(*) FILTER (WHERE r.state IN ('delivered', 'read'))::text AS delivered
         FROM delivery_batches b
         JOIN delivery_receipts r ON r.message_id = b.message_id
        WHERE b.message_id = $1
        GROUP BY b.expected_count`,
      [messageId],
    );
    expect(audit.rows[0].expected_count).toBe(3);
    expect(audit.rows[0].delivered).toBe('3');
  });

  it('RECHAZA borrar el batch mientras existan receipts: la evidencia manda', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    await testPool().query('DELETE FROM delivery_envelopes WHERE message_id = $1', [messageId]);

    await expectViolation(
      () => testPool().query('DELETE FROM delivery_batches WHERE message_id = $1', [messageId]),
      { code: PG_ERROR.FOREIGN_KEY_VIOLATION, constraint: 'delivery_receipts_batch_fkey' },
    );

    expect(await countRows('delivery_batches')).toBe(1);
  });

  it('RECHAZA crear trabajo de entrega sin snapshot previo', async () => {
    const messageId = await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });

    // No puede haber envelopes sin batch: seria trabajo de entrega sin nadie que sepa
    // cuando esta completo, es decir, envelopes que no se limpian nunca.
    await expectViolation(() => insertEnvelope(messageId, fixture.deviceIds[0]), {
      code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      constraint: 'delivery_envelopes_batch_fkey',
    });
  });

  it('RECHAZA un snapshot de un mensaje que no existe', async () => {
    await expectViolation(
      () => insertDeliveryBatch({ messageId: uuid(), expectedCount: 1 }),
      { code: PG_ERROR.FOREIGN_KEY_VIOLATION, constraint: 'delivery_batches_message_fkey' },
    );
  });
});

describe('delivery_batches — un solo snapshot por mensaje', () => {
  it('RECHAZA un segundo batch para el mismo mensaje', async () => {
    const messageId = await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });
    await insertDeliveryBatch({ messageId, expectedCount: 3 });

    // C1 exige "exactamente un batch de delivery". Dos owners de la misma key, o un
    // retry que reejecuta `deliveries_created`, chocan aca.
    await expectViolation(() => insertDeliveryBatch({ messageId, expectedCount: 3 }), {
      code: PG_ERROR.UNIQUE_VIOLATION,
      constraint: 'delivery_batches_pkey',
    });

    expect(await countRows('delivery_batches')).toBe(1);
  });

  it('CARRERA: 20 intentos concurrentes de crear el snapshot dejan uno solo', async () => {
    const messageId = await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => insertDeliveryBatch({ messageId, expectedCount: 3 })),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows('delivery_batches')).toBe(1);
  });

  it('RECHAZA progreso por encima del snapshot (I8: un ack duplicado contaria dos veces)', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    await expectViolation(
      () =>
        testPool().query(
          'UPDATE delivery_batches SET delivered_count = expected_count + 1 WHERE message_id = $1',
          [messageId],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_batches_delivered_not_above_expected',
      },
    );
  });

  it('RECHAZA limpiar por "completed" un batch que nunca se completo (I9)', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    // Dos dispositivos de tres ackearon: queda trabajo pendiente. Declarar el cleanup
    // como `completed` borraria envelopes que alguien todavia espera.
    await testPool().query(
      'UPDATE delivery_batches SET delivered_count = 2 WHERE message_id = $1',
      [messageId],
    );

    await expectViolation(
      () =>
        testPool().query(
          `UPDATE delivery_batches SET cleanup_at = now(), cleanup_reason = 'completed'
            WHERE message_id = $1`,
          [messageId],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_batches_cleanup_requires_completion_or_expiry',
      },
    );
  });

  it('RECHAZA limpiar sin declarar por que', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    // Sin razon no hay auditoria posible: despues del cleanup no habria forma de
    // distinguir un batch que termino de uno que se abandono por TTL.
    await expectViolation(
      () =>
        testPool().query('UPDATE delivery_batches SET cleanup_at = now() WHERE message_id = $1', [
          messageId,
        ]),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'delivery_batches_cleanup_has_reason' },
    );
  });

  it('RECHAZA una razon de cleanup inventada', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    await expectViolation(
      () =>
        testPool().query(
          `UPDATE delivery_batches SET cleanup_at = now(), cleanup_reason = 'porque si'
            WHERE message_id = $1`,
          [messageId],
        ),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'delivery_batches_cleanup_reason_valid' },
    );
  });

  it('PERMITE limpiar por TTL un batch incompleto, dejando registrado que expiro', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    // El caso que el CHECK original del slice 1 volvia imposible: un dispositivo que
    // nunca vuelve no puede dejar envelopes colgados para siempre.
    await testPool().query(
      `UPDATE delivery_batches
          SET expires_at = now() - interval '1 hour',
              cleanup_at = now(), cleanup_reason = 'expired'
        WHERE message_id = $1`,
      [messageId],
    );

    const stored = await testPool().query<{ completed_at: Date | null; cleanup_reason: string }>(
      'SELECT completed_at, cleanup_reason FROM delivery_batches WHERE message_id = $1',
      [messageId],
    );
    // No se disfraza de entrega exitosa: completed_at sigue nulo.
    expect(stored.rows[0].completed_at).toBeNull();
    expect(stored.rows[0].cleanup_reason).toBe('expired');
  });

  it('RECHAZA declarar completo un batch con progreso incompleto', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    await expectViolation(
      () =>
        testPool().query(
          'UPDATE delivery_batches SET delivered_count = 2, completed_at = now() WHERE message_id = $1',
          [messageId],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_batches_completed_requires_full_progress',
      },
    );
  });

  it('RECHAZA un snapshot de cero destinatarios', async () => {
    const messageId = await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });

    await expectViolation(() => insertDeliveryBatch({ messageId, expectedCount: 0 }), {
      code: PG_ERROR.CHECK_VIOLATION,
      constraint: 'delivery_batches_expected_count_positive',
    });
  });
});

describe('delivery_envelopes — una unidad de trabajo por dispositivo', () => {
  it('RECHAZA un segundo envelope para el mismo (mensaje, dispositivo)', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    // "Ninguna delivery duplicada" (C1): el dispositivo recibiria el mensaje dos veces
    // y el cleanup contaria mal el trabajo restante.
    await expectViolation(() => insertEnvelope(messageId, fixture.deviceIds[0]), {
      code: PG_ERROR.UNIQUE_VIOLATION,
      constraint: 'delivery_envelopes_message_device_uniq',
    });

    expect(await countRows('delivery_envelopes')).toBe(3);
  });

  it('CARRERA: 20 intentos concurrentes de crear el mismo envelope dejan uno solo', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => insertEnvelope(messageId, newcomer)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows('delivery_envelopes')).toBe(4);
  });

  it('RECHAZA un estado de envelope fuera del dominio', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    await expectViolation(() => insertEnvelope(messageId, newcomer, 'read' as never), {
      code: PG_ERROR.CHECK_VIOLATION,
      constraint: 'delivery_envelopes_state_valid',
    });
  });
});

describe('delivery_receipts — un recibo durable por dispositivo', () => {
  it('RECHAZA un segundo recibo para el mismo (mensaje, dispositivo)', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    await expectViolation(
      () => insertReceipt({ messageId, deviceId: fixture.deviceIds[0], state: 'delivered' }),
      { code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'delivery_receipts_pkey' },
    );

    expect(await countRows('delivery_receipts')).toBe(3);
  });

  it('CARRERA: 20 acks concurrentes del mismo dispositivo dejan un solo recibo', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    // Dos acks del mismo dispositivo llegan a dos replicas distintas. Sin la PK
    // compuesta cada una insertaria su propio recibo y el batch contaria dos
    // progresos para un solo destinatario (I8).
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        insertReceipt({ messageId, deviceId: newcomer, state: 'delivered' }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows('delivery_receipts')).toBe(4);
  });

  it('RECHAZA un recibo "read" que nunca fue entregado (I7: no se saltan estados)', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    await expectViolation(
      () =>
        insertReceipt({
          messageId,
          deviceId: newcomer,
          state: 'read',
          deliveredAt: null,
          readAt: new Date(),
        }),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_receipts_state_matches_timestamps',
      },
    );
  });

  it('RECHAZA un UPDATE que salta de pending a read sin pasar por delivered', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);

    await expectViolation(
      () =>
        testPool().query(
          `UPDATE delivery_receipts SET state = 'read', read_at = now(), version = version + 1
            WHERE message_id = $1 AND device_id = $2`,
          [messageId, fixture.deviceIds[0]],
        ),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_receipts_state_matches_timestamps',
      },
    );

    const stored = await testPool().query<{ state: string }>(
      'SELECT state FROM delivery_receipts WHERE message_id = $1 AND device_id = $2',
      [messageId, fixture.deviceIds[0]],
    );
    expect(stored.rows[0].state).toBe('pending');
  });

  it('RECHAZA un recibo pending con timestamp de entrega', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    await expectViolation(
      () =>
        insertReceipt({
          messageId,
          deviceId: newcomer,
          state: 'pending',
          deliveredAt: new Date(),
        }),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'delivery_receipts_state_matches_timestamps',
      },
    );
  });

  it('RECHAZA un estado de recibo fuera del dominio', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const newcomer = await createDevice();

    await expectViolation(
      () =>
        insertReceipt({
          messageId,
          deviceId: newcomer,
          state: 'casi_leido' as never,
          deliveredAt: null,
          readAt: null,
        }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'delivery_receipts_state_valid' },
    );
  });

  it('ACEPTA el avance completo pending -> delivered -> read', async () => {
    const messageId = await publishWithDeliveries(fixture, 1, 1);
    const pool = testPool();
    const deviceId = fixture.deviceIds[0];

    await pool.query(
      `UPDATE delivery_receipts SET state = 'delivered', delivered_at = now(), version = version + 1
        WHERE message_id = $1 AND device_id = $2`,
      [messageId, deviceId],
    );
    await pool.query(
      `UPDATE delivery_receipts SET state = 'read', read_at = now(), version = version + 1
        WHERE message_id = $1 AND device_id = $2`,
      [messageId, deviceId],
    );

    const stored = await pool.query<{ state: string; version: string }>(
      'SELECT state, version::text AS version FROM delivery_receipts WHERE message_id = $1 AND device_id = $2',
      [messageId, deviceId],
    );
    expect(stored.rows[0].state).toBe('read');
    expect(stored.rows[0].version).toBe('2');
  });
});
