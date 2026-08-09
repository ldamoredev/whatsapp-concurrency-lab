import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SendMessageService,
  type SendMessageCommand,
} from '../../src/application/send-message.service';
import {
  ClientSequenceConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  SenderNotInConversationError,
} from '../../src/domain/idempotency/errors';
import { SEND_MESSAGE_ROUTE } from '../../src/domain/idempotency/idempotency-operation';
import {
  claimOperation,
  completeOperation,
  findOperation,
} from '../../src/infrastructure/persistence/idempotency-operations.repository';
import { closeTestPool, countRows, testPool, truncateAll } from './helpers/database';
import { createConversationWithDevices, createDevice, type ConversationFixture } from './helpers/fixtures';

let fixture: ConversationFixture;

/** Lease largo: el owner nunca lo pierde salvo que el test lo fuerce. */
const service = (): SendMessageService =>
  new SendMessageService(testPool(), { leaseMs: 30_000, ttlMs: 60_000 });

function commandFor(
  fx: ConversationFixture,
  overrides: Partial<SendMessageCommand> = {},
): SendMessageCommand {
  return {
    idempotencyKey: `key-${randomUUID()}`,
    conversationId: fx.conversationId,
    senderId: fx.ownerId,
    senderDeviceId: fx.senderDeviceId,
    clientMessageId: 'local-1',
    clientSequence: 1,
    body: 'hola',
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

afterAll(async () => {
  await closeTestPool();
});

describe('envio idempotente — camino feliz', () => {
  it('crea el mensaje publicado y su snapshot de entrega completo, en un solo commit', async () => {
    const result = await service().send(commandFor(fixture));

    expect(result.status).toBe(201);
    expect(result.replayed).toBe(false);
    expect(result.payload.serverSequence).toBe(1);

    // El mensaje existe, publicado y con lugar en la conversacion.
    const message = await testPool().query<{ status: string; server_sequence: string }>(
      'SELECT status, server_sequence FROM messages WHERE id = $1',
      [result.payload.messageId],
    );
    expect(message.rows[0].status).toBe('published');
    expect(message.rows[0].server_sequence).toBe('1');

    // Y su snapshot: un batch, y un envelope + un receipt por cada uno de los 3 devices.
    expect(await countRows('delivery_batches')).toBe(1);
    expect(await countRows('delivery_envelopes')).toBe(3);
    expect(await countRows('delivery_receipts')).toBe(3);

    const batch = await testPool().query<{ expected_count: number }>(
      'SELECT expected_count FROM delivery_batches WHERE message_id = $1',
      [result.payload.messageId],
    );
    expect(batch.rows[0].expected_count).toBe(3);
  });

  it('avanza el contador de la conversacion: server_sequence 1, 2, 3 consecutivas', async () => {
    const svc = service();

    const first = await svc.send(commandFor(fixture, { clientSequence: 1, clientMessageId: 'a' }));
    const second = await svc.send(commandFor(fixture, { clientSequence: 2, clientMessageId: 'b' }));
    const third = await svc.send(commandFor(fixture, { clientSequence: 3, clientMessageId: 'c' }));

    expect([first, second, third].map((r) => r.payload.serverSequence)).toEqual([1, 2, 3]);

    const counter = await testPool().query<{ next_server_sequence: string; version: string }>(
      'SELECT next_server_sequence, version::text AS version FROM conversation_sequences WHERE conversation_id = $1',
      [fixture.conversationId],
    );
    expect(counter.rows[0].next_server_sequence).toBe('4');
    expect(counter.rows[0].version).toBe('3');
  });

  it('guarda la respuesta reproducible junto con el efecto (I3)', async () => {
    const command = commandFor(fixture);
    const result = await service().send(command);

    const operation = await findOperation(
      testPool(),
      command.senderId,
      SEND_MESSAGE_ROUTE,
      command.idempotencyKey,
    );

    expect(operation?.status).toBe('completed');
    expect(operation?.recoveryPoint).toBe('completed');
    expect(operation?.resourceId).toBe(result.payload.messageId);
    expect(operation?.responseStatus).toBe(201);
    expect(operation?.leaseUntil).toBeNull();
    expect((operation?.responseBody as { messageId: string }).messageId).toBe(
      result.payload.messageId,
    );
  });
});

describe('envio idempotente — replay', () => {
  it('el mismo pedido con la misma key devuelve el mismo mensaje y NO crea otro', async () => {
    const command = commandFor(fixture);
    const svc = service();

    const first = await svc.send(command);
    const second = await svc.send(command);

    expect(second.status).toBe(200);
    expect(second.replayed).toBe(true);
    expect(second.payload.messageId).toBe(first.payload.messageId);

    expect(await countRows('messages')).toBe(1);
    expect(await countRows('delivery_batches')).toBe(1);
    expect(await countRows('delivery_envelopes')).toBe(3);
  });

  it('C2 — la respuesta se perdio despues del commit: el retry recupera el resultado', async () => {
    const command = commandFor(fixture);
    const svc = service();

    // El commit ocurrio. El cliente NUNCA vio esta respuesta: se corto el socket.
    const perdida = await svc.send(command);

    // Reintenta a ciegas con la misma key, sin saber si el primero funciono.
    const recuperada = await svc.send(command);

    expect(recuperada.payload).toEqual(perdida.payload);
    expect(recuperada.status).toBe(200);

    // Y en la base hay UN solo efecto. Este es el chequeo que importa: contar
    // respuestas 2xx no demostraria nada.
    expect(await countRows('messages')).toBe(1);
    expect(await countRows('delivery_batches')).toBe(1);
  });

  it('10 retries seguidos siguen devolviendo el mismo mensaje', async () => {
    const command = commandFor(fixture);
    const svc = service();

    const first = await svc.send(command);
    for (let i = 0; i < 10; i += 1) {
      const retry = await svc.send(command);
      expect(retry.payload.messageId).toBe(first.payload.messageId);
    }

    expect(await countRows('messages')).toBe(1);
  });
});

describe('envio idempotente — conflictos', () => {
  it('I2 — misma key con otro body: 409 y el efecto original queda intacto', async () => {
    const command = commandFor(fixture);
    const svc = service();

    const original = await svc.send(command);

    await expect(svc.send({ ...command, body: 'otro contenido' })).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );

    // Ni se ejecuto, ni se toco lo que ya estaba.
    expect(await countRows('messages')).toBe(1);
    const stored = await testPool().query<{ body: string }>(
      'SELECT body FROM messages WHERE id = $1',
      [original.payload.messageId],
    );
    expect(stored.rows[0].body).toBe('hola');
  });

  it('I2 — el chequeo de fingerprint tambien aplica mientras la operacion esta en curso', async () => {
    const command = commandFor(fixture);

    // Simula un owner trabajando en otro pod: la key esta tomada, sin completar.
    await claimOperation(testPool(), {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint: 'fingerprint-de-otro-pedido',
      leaseMs: 30_000,
      ttlMs: 60_000,
    });

    await expect(service().send(command)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await countRows('messages')).toBe(0);
  });

  it('la operacion en curso de otro pod devuelve IDEMPOTENCY_IN_PROGRESS con Retry-After', async () => {
    const command = commandFor(fixture);
    const svc = service();

    // Mismo fingerprint, pero el dueño todavia no termino.
    const { fingerprintOf } = await import('../../src/domain/idempotency/fingerprint');
    await claimOperation(testPool(), {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint: fingerprintOf(command),
      leaseMs: 30_000,
      ttlMs: 60_000,
    });

    const error = await svc.send(command).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IdempotencyInProgressError);
    expect((error as IdempotencyInProgressError).retryAfterSeconds).toBeGreaterThan(0);
    expect(await countRows('messages')).toBe(0);
  });

  it('el mismo client_sequence con OTRO contenido y otra key es un conflicto (I4)', async () => {
    const svc = service();
    await svc.send(commandFor(fixture, { clientSequence: 1, clientMessageId: 'a', body: 'uno' }));

    await expect(
      svc.send(commandFor(fixture, { clientSequence: 1, clientMessageId: 'b', body: 'dos' })),
    ).rejects.toBeInstanceOf(ClientSequenceConflictError);

    expect(await countRows('messages')).toBe(1);
  });

  it('el mismo mensaje reenviado con una key NUEVA se adopta en vez de duplicarse', async () => {
    // El caso real: el cliente perdio la respuesta y su retry genero otra
    // idempotency key. I1 no puede unirlos porque son operaciones distintas; el que
    // los une es I4, que ata la unicidad al dominio y no al transporte.
    // client_sequence 1: es el esperado, asi que se publica y genera deliveries. Con
    // un numero adelantado el mensaje quedaria buffered, que es otro caso (slice 3).
    const svc = service();
    const first = await svc.send(commandFor(fixture, { clientSequence: 1, clientMessageId: 'x' }));

    const retryConKeyNueva = await svc.send(
      commandFor(fixture, { clientSequence: 1, clientMessageId: 'x' }),
    );

    expect(retryConKeyNueva.status).toBe(200);
    expect(retryConKeyNueva.payload.messageId).toBe(first.payload.messageId);
    expect(await countRows('messages')).toBe(1);
    expect(await countRows('delivery_envelopes')).toBe(3);
  });

  it('un dispositivo que no participa de la conversacion no puede enviar', async () => {
    const outsider = await createDevice();

    await expect(
      service().send(commandFor(fixture, { senderDeviceId: outsider })),
    ).rejects.toBeInstanceOf(SenderNotInConversationError);

    expect(await countRows('messages')).toBe(0);
    // La operacion idempotente queda marcada failed para que un retry pueda retomarla.
    expect(await countRows('idempotency_operations')).toBe(1);
  });

  it('una conversacion inexistente no crea nada', async () => {
    await expect(
      service().send(commandFor(fixture, { conversationId: randomUUID() })),
    ).rejects.toBeInstanceOf(SenderNotInConversationError);

    expect(await countRows('messages')).toBe(0);
  });
});

describe('lease y fencing', () => {
  it('retoma una operacion abandonada cuando el lease vencio, subiendo el attempt', async () => {
    const command = commandFor(fixture);

    // Un owner reclamo la key y murio: lease de 1ms, ya vencido.
    const abandonada = await claimOperation(testPool(), {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint: (await import('../../src/domain/idempotency/fingerprint')).fingerprintOf(command),
      leaseMs: 1,
      ttlMs: 60_000,
    });
    expect(abandonada?.attempt).toBe(1);

    const result = await service().send(command);

    expect(result.status).toBe(201);
    expect(await countRows('messages')).toBe(1);

    const operation = await findOperation(
      testPool(),
      command.senderId,
      SEND_MESSAGE_ROUTE,
      command.idempotencyKey,
    );
    // attempt 2: el nuevo owner tomo el lease del anterior.
    expect(operation?.attempt).toBe(2);
    expect(operation?.status).toBe('completed');
  });

  it('la vigencia del lease la decide PostgreSQL, no el reloj de este proceso', async () => {
    // Regresion. La version anterior comparaba `operation.leaseUntil > new Date()`:
    // el `lease_until` lo escribe Postgres y la comparacion la hacia Node. Con un
    // lease muy corto el test fallaba de forma intermitente, y con tres pods de
    // relojes minimamente distintos habria dado tres respuestas para la misma
    // operacion. Ahora el booleano viene calculado en el SELECT.
    const command = commandFor(fixture);

    await claimOperation(testPool(), {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint: (await import('../../src/domain/idempotency/fingerprint')).fingerprintOf(command),
      leaseMs: 1,
      ttlMs: 60_000,
    });

    const operation = await findOperation(
      testPool(),
      command.senderId,
      SEND_MESSAGE_ROUTE,
      command.idempotencyKey,
    );

    // Ya vencido segun la base, sin importar como ande el reloj de Node.
    expect(operation?.leaseIsAlive).toBe(false);

    // Y uno que reci\u00e9n se tomo, con lease largo, sigue vivo.
    const otro = commandFor(fixture, { clientSequence: 2 });
    await claimOperation(testPool(), {
      actorId: otro.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: otro.idempotencyKey,
      fingerprint: 'fp',
      leaseMs: 60_000,
      ttlMs: 60_000,
    });

    const vigente = await findOperation(
      testPool(),
      otro.senderId,
      SEND_MESSAGE_ROUTE,
      otro.idempotencyKey,
    );
    expect(vigente?.leaseIsAlive).toBe(true);
  });

  it('un owner viejo NO puede completar una operacion cuyo lease ya perdio', async () => {
    const command = commandFor(fixture);

    const viejo = await claimOperation(testPool(), {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint: 'fp',
      leaseMs: 1,
      ttlMs: 60_000,
    });

    // Otro proceso retoma: attempt pasa a 2.
    const { takeOverExpiredLease } = await import(
      '../../src/infrastructure/persistence/idempotency-operations.repository'
    );
    const nuevo = await takeOverExpiredLease(testPool(), viejo!.operationId, 1, 30_000);
    expect(nuevo?.attempt).toBe(2);

    // El owner viejo revive e intenta cerrar con SU attempt. El UPDATE no matchea.
    const completado = await completeOperation(testPool(), {
      operationId: viejo!.operationId,
      attempt: viejo!.attempt,
      resourceId: randomUUID(),
      responseStatus: 201,
      responseBody: { messageId: 'fantasma' },
    });

    expect(completado).toBe(false);

    // Y la operacion sigue en curso, en manos del owner nuevo.
    const operation = await findOperation(
      testPool(),
      command.senderId,
      SEND_MESSAGE_ROUTE,
      command.idempotencyKey,
    );
    expect(operation?.status).toBe('in_progress');
    expect(operation?.attempt).toBe(2);
    expect(operation?.resourceId).toBeNull();
  });
});

describe('C1 — carrera de idempotencia', () => {
  it('100 envios concurrentes con la misma key producen UN mensaje y UN batch', async () => {
    const command = commandFor(fixture);
    const svc = service();
    const attempts = 100;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => svc.send(command)),
    );

    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 201,
    );
    const replayed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200,
    );
    const inProgress = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof IdempotencyInProgressError,
    );

    // Exactamente uno creo el mensaje.
    expect(created).toHaveLength(1);

    // Y NINGUNA respuesta fue algo distinto de lo esperado: 201, replay o in-progress.
    expect(created.length + replayed.length + inProgress.length).toBe(attempts);

    // El chequeo que de verdad importa: la base al final.
    expect(await countRows('messages')).toBe(1);
    expect(await countRows('delivery_batches')).toBe(1);
    expect(await countRows('delivery_envelopes')).toBe(3);
    expect(await countRows('delivery_receipts')).toBe(3);
    expect(await countRows('idempotency_operations')).toBe(1);

    // Ninguna delivery duplicada.
    const duplicadas = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT message_id, device_id FROM delivery_envelopes
          GROUP BY message_id, device_id HAVING count(*) > 1
       ) AS dup`,
    );
    expect(duplicadas.rows[0].count).toBe('0');

    // Y un retry posterior devuelve el mismo resultado persistido.
    const retry = await svc.send(command);
    const ganador = (created[0] as PromiseFulfilledResult<{ payload: { messageId: string } }>).value;
    expect(retry.payload.messageId).toBe(ganador.payload.messageId);
    expect(await countRows('messages')).toBe(1);
  });

  it('100 envios concurrentes con la misma key y bodies DISTINTOS no dejan efecto de mas', async () => {
    const command = commandFor(fixture);
    const svc = service();

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_unused, index) =>
        svc.send({ ...command, body: `variante-${index}` }),
      ),
    );

    const created = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
    const reused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof IdempotencyKeyReusedError,
    );

    // A lo sumo uno gana la key; todos los demas son conflicto o in-progress.
    expect(created.length).toBeLessThanOrEqual(1);
    expect(reused.length).toBeGreaterThan(0);

    // Nunca mas de un mensaje, pase lo que pase.
    expect(await countRows('messages')).toBeLessThanOrEqual(1);
    expect(await countRows('idempotency_operations')).toBe(1);
  });

  it('envios concurrentes con keys DISTINTAS y client_sequences distintos publican todos, en orden unico', async () => {
    const svc = service();
    const total = 20;

    const results = await Promise.allSettled(
      Array.from({ length: total }, (_unused, index) =>
        svc.send(
          commandFor(fixture, {
            clientSequence: index + 1,
            clientMessageId: `local-${index + 1}`,
            body: `mensaje ${index + 1}`,
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(total);
    expect(await countRows('messages')).toBe(total);

    // I5: las 20 posiciones son unicas y consecutivas, sin huecos ni repetidas.
    const sequences = await testPool().query<{ server_sequence: string }>(
      'SELECT server_sequence FROM messages WHERE conversation_id = $1 ORDER BY server_sequence',
      [fixture.conversationId],
    );
    expect(sequences.rows.map((row) => Number.parseInt(row.server_sequence, 10))).toEqual(
      Array.from({ length: total }, (_unused, index) => index + 1),
    );
  });
});
