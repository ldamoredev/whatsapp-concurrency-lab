import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpireGapsService } from '../../src/application/expire-gaps.service';
import {
  SendMessageService,
  type SendMessageCommand,
} from '../../src/application/send-message.service';
import {
  InvalidResyncError,
  StreamResyncRequiredError,
} from '../../src/domain/idempotency/errors';
import { findStream } from '../../src/infrastructure/persistence/device-sequences.repository';
import { closeTestPool, countRows, testPool, truncateAll } from './helpers/database';
import { createConversationWithDevices, type ConversationFixture } from './helpers/fixtures';

let fixture: ConversationFixture;

/** `gapTimeoutMs` corto para poder vencer un hueco sin esperar medio minuto. */
const service = (gapTimeoutMs = 30_000): SendMessageService =>
  new SendMessageService(testPool(), { leaseMs: 30_000, ttlMs: 60_000, gapTimeoutMs });

function commandFor(overrides: Partial<SendMessageCommand> = {}): SendMessageCommand {
  return {
    idempotencyKey: `key-${randomUUID()}`,
    conversationId: fixture.conversationId,
    senderId: fixture.ownerId,
    senderDeviceId: fixture.senderDeviceId,
    clientMessageId: `local-${overrides.clientSequence ?? 1}`,
    clientSequence: 1,
    body: `mensaje ${overrides.clientSequence ?? 1}`,
    ...overrides,
  };
}

const send = (clientSequence: number, svc = service()) =>
  svc.send(commandFor({ clientSequence }));

async function stream() {
  return findStream(testPool(), fixture.conversationId, fixture.senderDeviceId);
}

async function ordenVisible(): Promise<Array<{ server: number | null; body: string }>> {
  const result = await testPool().query<{ server_sequence: string | null; body: string }>(
    `SELECT server_sequence, body FROM messages
      WHERE conversation_id = $1
      ORDER BY server_sequence NULLS LAST`,
    [fixture.conversationId],
  );

  return result.rows.map((row) => ({
    server: row.server_sequence === null ? null : Number.parseInt(row.server_sequence, 10),
    body: row.body,
  }));
}

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * C3 del alcance: enviar 1, 3 y 4; verificar que 3 y 4 quedan bufferizados. Enviar 2 y
 * verificar orden visible 1, 2, 3, 4 con server_sequence consecutiva.
 */
describe('C3 — orden y huecos', () => {
  it('el esperado se publica', async () => {
    const result = await send(1);

    expect(result.status).toBe(201);
    expect(result.payload.status).toBe('published');
    expect(result.payload.serverSequence).toBe(1);
    expect(result.payload.stream).toEqual({ state: 'ok', nextClientSequence: 2 });
  });

  it('los adelantados quedan BUFFERED: sin orden visible y sin trabajo de entrega', async () => {
    await send(1);

    const tres = await send(3);
    const cuatro = await send(4);

    // 202 Accepted: llegaron, pero para la conversacion todavia no paso nada.
    expect(tres.status).toBe(202);
    expect(cuatro.status).toBe(202);
    expect(tres.payload.status).toBe('buffered');
    expect(tres.payload.serverSequence).toBeNull();

    // I6 — no tienen lugar en la conversacion.
    const buffered = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE status = 'buffered' AND server_sequence IS NULL",
    );
    expect(buffered.rows[0].count).toBe('2');

    // Y NO generaron trabajo de entrega: nadie los va a recibir todavia.
    expect(await countRows('delivery_batches')).toBe(1); // solo el del mensaje 1
    expect(await countRows('delivery_envelopes')).toBe(3);

    // El contador de la conversacion no se movio por ellos.
    const counter = await testPool().query<{ next_server_sequence: string }>(
      'SELECT next_server_sequence FROM conversation_sequences WHERE conversation_id = $1',
      [fixture.conversationId],
    );
    expect(counter.rows[0].next_server_sequence).toBe('2');

    // El stream quedo esperando, con un deadline corriendo.
    const s = await stream();
    expect(s?.state).toBe('waiting_gap');
    expect(s?.nextClientSequence).toBe(2);
    expect(s?.gapDeadline).not.toBeNull();
  });

  it('al llegar el que faltaba se publica y se DRENA la cascada: 1, 2, 3, 4', async () => {
    await send(1);
    await send(3);
    await send(4);

    const dos = await send(2);

    // El 2 se publico y arrastro al 3 y al 4 en el mismo commit.
    expect(dos.status).toBe(201);
    expect(dos.payload.serverSequence).toBe(2);
    expect(dos.payload.drained).toBe(2);
    expect(dos.payload.stream).toEqual({ state: 'ok', nextClientSequence: 5 });

    // Orden visible: consecutivo y en el orden del stream, no en el de llegada.
    expect(await ordenVisible()).toEqual([
      { server: 1, body: 'mensaje 1' },
      { server: 2, body: 'mensaje 2' },
      { server: 3, body: 'mensaje 3' },
      { server: 4, body: 'mensaje 4' },
    ]);

    // Nada quedo bufferizado.
    const buffered = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE status = 'buffered'",
    );
    expect(buffered.rows[0].count).toBe('0');

    // Y recien ahora los cuatro tienen trabajo de entrega para los 3 dispositivos.
    expect(await countRows('delivery_batches')).toBe(4);
    expect(await countRows('delivery_envelopes')).toBe(12);
    expect(await countRows('delivery_receipts')).toBe(12);

    const s = await stream();
    expect(s?.state).toBe('ok');
    expect(s?.gapDeadline).toBeNull();
  });

  it('I6 — el 3 NUNCA fue visible antes que el 2', async () => {
    await send(1);
    await send(3);

    // Instantanea mientras el hueco existe: el 3 no tiene lugar en la conversacion.
    const durante = await testPool().query<{ server_sequence: string | null }>(
      "SELECT server_sequence FROM messages WHERE body = 'mensaje 3'",
    );
    expect(durante.rows[0].server_sequence).toBeNull();

    await send(2);

    // Y cuando se publica, lo hace DETRAS del 2, no delante.
    const despues = await testPool().query<{ body: string }>(
      `SELECT body FROM messages
        WHERE status = 'published' AND conversation_id = $1
        ORDER BY server_sequence`,
      [fixture.conversationId],
    );
    expect(despues.rows.map((r) => r.body)).toEqual(['mensaje 1', 'mensaje 2', 'mensaje 3']);
  });

  it('drena solo lo CONTIGUO: con 1, 3, 5 el 5 sigue esperando tras llegar el 2', async () => {
    await send(1);
    await send(3);
    await send(5);

    const dos = await send(2);

    // Publica 2 y 3. El 5 no, porque falta el 4.
    expect(dos.payload.drained).toBe(1);

    expect(await ordenVisible()).toEqual([
      { server: 1, body: 'mensaje 1' },
      { server: 2, body: 'mensaje 2' },
      { server: 3, body: 'mensaje 3' },
      { server: null, body: 'mensaje 5' },
    ]);

    // El hueco sigue abierto en el 4.
    const s = await stream();
    expect(s?.state).toBe('waiting_gap');
    expect(s?.nextClientSequence).toBe(4);
    expect(s?.gapDeadline).not.toBeNull();
  });

  it('un client_sequence ya procesado es replay, no un mensaje nuevo', async () => {
    const svc = service();
    const original = await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 2 }));

    // Reenvia el 1 con una idempotency key NUEVA.
    const replay = await svc.send(commandFor({ clientSequence: 1 }));

    expect(replay.status).toBe(200);
    expect(replay.payload.messageId).toBe(original.payload.messageId);
    expect(await countRows('messages')).toBe(2);
  });

  it('el deadline del hueco NO se estira al seguir mandando adelantados', async () => {
    await send(1);
    await send(3);
    const primero = await stream();

    await send(4);
    await send(5);
    const despues = await stream();

    // Mismo deadline: se mide desde que aparecio el hueco, no desde el ultimo mensaje.
    // Si se reiniciara, un cliente que sigue mandando nunca dejaria expirar el hueco.
    expect(despues?.gapDeadline?.getTime()).toBe(primero?.gapDeadline?.getTime());
  });
});

describe('C3 — el hueco que vence', () => {
  it('el barrido manda el stream a resync_required, sin publicar nada en silencio', async () => {
    // Deadline de 1 ms: el hueco nace vencido.
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));

    const expirados = await new ExpireGapsService(testPool()).run();

    expect(expirados).toHaveLength(1);
    const s = await stream();
    expect(s?.state).toBe('resync_required');
    expect(s?.nextClientSequence).toBe(2);
    expect(s?.gapDeadline).toBeNull();

    // Lo CRITICO: el 3 sigue sin publicarse. Vencer el deadline no significa
    // "publicalo igual" — significa "el cliente tiene que resolverlo".
    const tres = await testPool().query<{ status: string; server_sequence: string | null }>(
      "SELECT status, server_sequence FROM messages WHERE body = 'mensaje 3'",
    );
    expect(tres.rows[0].status).toBe('buffered');
    expect(tres.rows[0].server_sequence).toBeNull();
  });

  it('en resync_required se rechaza cualquier mensaje que no sea el que falta', async () => {
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));
    await new ExpireGapsService(testPool()).run();

    const error = await svc.send(commandFor({ clientSequence: 4 })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamResyncRequiredError);
    // El error le dice al cliente exactamente que reenviar.
    expect((error as StreamResyncRequiredError).nextClientSequence).toBe(2);
  });

  it('si el cliente reenvia el que faltaba, el stream se recupera y drena', async () => {
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));
    await new ExpireGapsService(testPool()).run();

    const dos = await svc.send(commandFor({ clientSequence: 2 }));

    expect(dos.status).toBe(201);
    expect(dos.payload.drained).toBe(1);
    expect(await ordenVisible()).toEqual([
      { server: 1, body: 'mensaje 1' },
      { server: 2, body: 'mensaje 2' },
      { server: 3, body: 'mensaje 3' },
    ]);

    const s = await stream();
    expect(s?.state).toBe('ok');
  });

  it('el barrido es idempotente y seguro con workers concurrentes', async () => {
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));

    // Cinco workers barriendo a la vez. Exactamente uno se lleva la fila.
    const expirer = new ExpireGapsService(testPool());
    const corridas = await Promise.all([
      expirer.run(),
      expirer.run(),
      expirer.run(),
      expirer.run(),
      expirer.run(),
    ]);

    expect(corridas.flat()).toHaveLength(1);

    // Y correrlo otra vez despues no vuelve a tocar nada.
    expect(await expirer.run()).toHaveLength(0);
  });

  it('no toca huecos cuyo deadline todavia no vencio', async () => {
    await send(1);
    await send(3); // deadline de 30 s

    expect(await new ExpireGapsService(testPool()).run()).toHaveLength(0);
    expect((await stream())?.state).toBe('waiting_gap');
  });
});

describe('C3 — resync explicito', () => {
  it('el cliente declara desde donde sigue y lo bufferizado se publica en orden', async () => {
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));
    await svc.send(commandFor({ clientSequence: 4 }));
    await new ExpireGapsService(testPool()).run();

    // "El 2 se perdio para siempre, sigo desde el 3." La decision es del cliente.
    const resultado = await svc.resync(fixture.conversationId, fixture.senderDeviceId, 3);

    expect(resultado.state).toBe('ok');
    expect(resultado.nextClientSequence).toBe(5);

    // El 3 y el 4 se publicaron en orden. El hueco del 2 queda documentado como tal:
    // nunca existio un mensaje ahi, y el orden visible no lo inventa.
    expect(await ordenVisible()).toEqual([
      { server: 1, body: 'mensaje 1' },
      { server: 2, body: 'mensaje 3' },
      { server: 3, body: 'mensaje 4' },
    ]);

    expect(await countRows('delivery_batches')).toBe(3);
    expect(await countRows('delivery_envelopes')).toBe(9);
  });

  it('RECHAZA retroceder a posiciones ya publicadas', async () => {
    const svc = service();
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 2 }));

    await expect(
      svc.resync(fixture.conversationId, fixture.senderDeviceId, 1),
    ).rejects.toBeInstanceOf(InvalidResyncError);

    expect((await stream())?.nextClientSequence).toBe(3);
  });

  it('despues de saltar un hueco, mandar el mensaje salteado NO lo publica fuera de orden', async () => {
    const svc = service(1);
    await svc.send(commandFor({ clientSequence: 1 }));
    await svc.send(commandFor({ clientSequence: 3 }));
    await new ExpireGapsService(testPool()).run();
    await svc.resync(fixture.conversationId, fixture.senderDeviceId, 3);

    // Llega tardisimo el 2. Su lugar en el orden ya no existe.
    const error = await svc.send(commandFor({ clientSequence: 2 })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamResyncRequiredError);
    expect(await countRows('messages')).toBe(2);
  });
});

describe('orden bajo concurrencia', () => {
  it('20 mensajes desordenados y concurrentes terminan en orden 1..20, sin huecos', async () => {
    const svc = service();
    const desordenados = [7, 3, 12, 1, 19, 5, 9, 2, 15, 4, 11, 6, 20, 8, 17, 10, 13, 18, 14, 16];

    await Promise.allSettled(
      desordenados.map((clientSequence) => svc.send(commandFor({ clientSequence }))),
    );

    // Algunos pueden haber chocado entre si; los que falten se reenvian, como haria
    // un cliente real.
    for (let clientSequence = 1; clientSequence <= 20; clientSequence += 1) {
      await svc.send(commandFor({ clientSequence })).catch(() => undefined);
    }

    const orden = await ordenVisible();

    expect(orden).toHaveLength(20);
    // server_sequence 1..20 sin repetidos ni huecos...
    expect(orden.map((m) => m.server)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index + 1),
    );
    // ...y en el orden del STREAM, no en el de llegada.
    expect(orden.map((m) => m.body)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `mensaje ${index + 1}`),
    );

    expect((await stream())?.state).toBe('ok');
    expect((await stream())?.nextClientSequence).toBe(21);
  });
});
