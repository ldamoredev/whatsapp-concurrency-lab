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
  insertMessage,
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
 * I4 — no hay dos mensajes para el mismo stream y client_sequence.
 * Indice unico: messages_stream_client_sequence_uniq (conversation_id, sender_device_id, client_sequence).
 */
describe('messages — I4: unicidad del stream del emisor', () => {
  it('RECHAZA dos mensajes en la misma posicion del mismo stream', async () => {
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 7,
    });

    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 7,
        }),
      {
        code: PG_ERROR.UNIQUE_VIOLATION,
        constraint: 'messages_stream_client_sequence_uniq',
      },
    );

    expect(await countRows('messages')).toBe(1);
  });

  it('PERMITE el mismo client_sequence desde otro dispositivo: son streams distintos', async () => {
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[0],
      clientSequence: 1,
    });
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[1],
      clientSequence: 1,
    });

    expect(await countRows('messages')).toBe(2);
  });

  it('PERMITE el mismo (dispositivo, client_sequence) en otra conversacion', async () => {
    const other = await createConversationWithDevices(1);

    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
    });
    await insertMessage({
      conversationId: other.conversationId,
      senderDeviceId: other.senderDeviceId,
      clientSequence: 1,
    });

    expect(await countRows('messages')).toBe(2);
  });

  it('CARRERA: 30 envios concurrentes del mismo client_sequence crean un solo mensaje', async () => {
    // El cliente pierde la respuesta y reintenta contra otra replica; las dos
    // requests estan en vuelo a la vez. Aunque la idempotency key del retry fuera
    // nueva (y por lo tanto I1 no las uniera), I4 impide el duplicado.
    const attempts = 30;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 42,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    for (const rejected of results.filter((result) => result.status === 'rejected')) {
      const error = (rejected as PromiseRejectedResult).reason;
      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION);
      expect(error.constraint).toBe('messages_stream_client_sequence_uniq');
    }

    expect(await countRows('messages')).toBe(1);
  });

  it('RECHAZA client_sequence 0: el stream empieza en 1', async () => {
    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 0,
        }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'messages_client_sequence_positive' },
    );
  });
});

/**
 * I5 — server_sequence es unica dentro de la conversacion, una vez publicada.
 * Indice unico PARCIAL: messages_conversation_server_sequence_uniq WHERE server_sequence IS NOT NULL.
 */
describe('messages — I5: unicidad del orden visible', () => {
  it('RECHAZA dos mensajes publicados en la misma posicion de la conversacion', async () => {
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[0],
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });

    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.deviceIds[1],
          clientSequence: 1,
          serverSequence: 1,
          status: 'published',
        }),
      {
        code: PG_ERROR.UNIQUE_VIOLATION,
        constraint: 'messages_conversation_server_sequence_uniq',
      },
    );

    expect(await countRows('messages')).toBe(1);
  });

  it('PERMITE el mismo server_sequence en otra conversacion: el orden es por conversacion', async () => {
    const other = await createConversationWithDevices(1);

    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });
    await insertMessage({
      conversationId: other.conversationId,
      senderDeviceId: other.senderDeviceId,
      clientSequence: 1,
      serverSequence: 1,
      status: 'published',
    });

    expect(await countRows('messages')).toBe(2);
  });

  it('PERMITE muchos mensajes buffered a la vez: todavia no compiten por una posicion', async () => {
    // El indice es parcial justamente para esto: con 1,3,4 los mensajes 3 y 4 quedan
    // buffered sin orden visible, y tienen que poder convivir.
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 3,
      serverSequence: null,
    });
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 4,
      serverSequence: null,
    });

    const buffered = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE status = 'buffered'",
    );
    expect(buffered.rows[0].count).toBe('2');
  });

  it('CARRERA: 30 publicaciones concurrentes en la posicion 5 dejan una sola', async () => {
    // Dos transacciones leyeron next_server_sequence = 5 antes de que la otra
    // commiteara. Sin la constraint quedarian dos mensajes en la posicion 5 y el
    // orden visible dejaria de ser un orden.
    const attempts = 30;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_unused, index) =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: index + 1,
          serverSequence: 5,
          status: 'published',
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    for (const rejected of results.filter((result) => result.status === 'rejected')) {
      const error = (rejected as PromiseRejectedResult).reason;
      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION);
      expect(error.constraint).toBe('messages_conversation_server_sequence_uniq');
    }

    expect(await countRows('messages')).toBe(1);
  });
});

/**
 * I6 (forma estatica) — un mensaje no puede ser visible sin tener lugar en la
 * conversacion, ni tener lugar sin ser visible.
 */
describe('messages — I6: estado y orden visible son la misma decision', () => {
  it('RECHAZA un mensaje published sin server_sequence', async () => {
    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 1,
          serverSequence: null,
          status: 'published',
        }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'messages_published_iff_server_sequence' },
    );
  });

  it('RECHAZA un mensaje buffered que ya ocupa una posicion visible', async () => {
    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 1,
          serverSequence: 3,
          status: 'buffered',
        }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'messages_published_iff_server_sequence' },
    );
  });

  it('RECHAZA publicar en dos pasos: un UPDATE que marca published sin asignar posicion', async () => {
    const messageId = await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      serverSequence: null,
    });

    // La ventana peligrosa es esta: "marco published ahora, le asigno el orden
    // despues". El CHECK la vuelve imposible incluso para un UPDATE.
    await expectViolation(
      () =>
        testPool().query("UPDATE messages SET status = 'published' WHERE id = $1", [messageId]),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'messages_published_iff_server_sequence' },
    );

    const stored = await testPool().query<{ status: string }>(
      'SELECT status FROM messages WHERE id = $1',
      [messageId],
    );
    expect(stored.rows[0].status).toBe('buffered');
  });

  it('RECHAZA un status fuera del dominio', async () => {
    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 1,
          status: 'medio_publicado' as never,
        }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'messages_status_valid' },
    );
  });
});

describe('messages — replay y pertenencia', () => {
  it('RECHAZA reusar client_message_id dentro del mismo stream', async () => {
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence: 1,
      clientMessageId: 'local-1',
    });

    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 2,
          clientMessageId: 'local-1',
        }),
      { code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'messages_client_message_id_uniq' },
    );
  });

  it('PERMITE el mismo client_message_id desde otro dispositivo: el id es local a cada cliente', async () => {
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[0],
      clientSequence: 1,
      clientMessageId: 'local-1',
    });
    await insertMessage({
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[1],
      clientSequence: 1,
      clientMessageId: 'local-1',
    });

    expect(await countRows('messages')).toBe(2);
  });

  it('RECHAZA un mensaje de un dispositivo que no es miembro de la conversacion', async () => {
    const outsider = await createDevice();

    // FK compuesta, no un chequeo previo en la aplicacion: entre "verifique que
    // pertenece" y "inserte" hay una ventana en la que la membresia pudo cambiar.
    await expectViolation(
      () =>
        insertMessage({
          conversationId: fixture.conversationId,
          senderDeviceId: outsider,
          clientSequence: 1,
        }),
      { code: PG_ERROR.FOREIGN_KEY_VIOLATION, constraint: 'messages_sender_membership_fkey' },
    );

    expect(await countRows('messages')).toBe(0);
  });

  it('RECHAZA un mensaje en una conversacion inexistente', async () => {
    // La misma FK compuesta cubre este caso: un dispositivo real no es miembro de una
    // conversacion que no existe.
    await expectViolation(
      () =>
        insertMessage({
          conversationId: uuid(),
          senderDeviceId: fixture.senderDeviceId,
          clientSequence: 1,
        }),
      { code: PG_ERROR.FOREIGN_KEY_VIOLATION, constraint: 'messages_sender_membership_fkey' },
    );
  });
});
