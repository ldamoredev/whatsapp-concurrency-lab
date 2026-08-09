import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap';
import { testDatabaseOptions } from '../../src/infrastructure/database/config';
import { closeTestPool, countRows, truncateAll } from '../integration/helpers/database';
import { createConversationWithDevices, type ConversationFixture } from '../integration/helpers/fixtures';

/**
 * e2e contra una instancia real: HTTP de verdad, sobre un puerto de verdad.
 *
 * Se usa `fetch` y no un inject en memoria porque lo que se quiere verificar aca son
 * los status, los headers y el contrato de errores tal como los ve un cliente.
 */

let app: NestFastifyApplication;
let baseUrl: string;
let fixture: ConversationFixture;

beforeAll(async () => {
  // La app tiene que hablar con la base de TESTS, no con la de desarrollo.
  process.env.DATABASE_URL = testDatabaseOptions().connectionString;

  // La MISMA construccion que usa el server: si los e2e armaran la app a su manera,
  // estarian probando una aplicacion que no es la que corre en produccion.
  app = await createApp({ logger: false });

  // Puerto 0: el sistema operativo elige uno libre y evita chocar con la app local.
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

interface SendOptions {
  key?: string;
  conversationId?: string;
  clientSequence?: number;
  clientMessageId?: string;
  body?: string;
  senderDeviceId?: string;
}

async function send(options: SendOptions = {}): Promise<Response> {
  const conversationId = options.conversationId ?? fixture.conversationId;

  return fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': options.key ?? `key-${randomUUID()}`,
    },
    body: JSON.stringify({
      senderId: fixture.ownerId,
      senderDeviceId: options.senderDeviceId ?? fixture.senderDeviceId,
      clientMessageId: options.clientMessageId ?? 'local-1',
      clientSequence: options.clientSequence ?? 1,
      body: options.body ?? 'hola',
    }),
  });
}

describe('POST /v1/conversations/:conversationId/messages', () => {
  it('201 la primera vez, con el mensaje publicado', async () => {
    const response = await send();
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get('x-idempotent-replay')).toBe('false');
    expect(payload.serverSequence).toBe(1);
    expect(payload.status).toBe('published');
    expect(payload.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('200 y el mismo messageId al reintentar con la misma key', async () => {
    const key = `key-${randomUUID()}`;

    const first = await send({ key });
    const second = await send({ key });

    const firstPayload = (await first.json()) as { messageId: string };
    const secondPayload = (await second.json()) as { messageId: string };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-idempotent-replay')).toBe('true');
    expect(secondPayload.messageId).toBe(firstPayload.messageId);

    expect(await countRows('messages')).toBe(1);
  });

  it('409 IDEMPOTENCY_KEY_REUSED con la misma key y otro body, sin ejecutar nada', async () => {
    const key = `key-${randomUUID()}`;

    await send({ key, body: 'original' });
    const conflicto = await send({ key, body: 'distinto' });
    const payload = (await conflicto.json()) as { code: string };

    expect(conflicto.status).toBe(409);
    expect(payload.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countRows('messages')).toBe(1);
  });

  it('409 CLIENT_SEQUENCE_CONFLICT si otro mensaje ya ocupa esa posicion del stream', async () => {
    await send({ clientSequence: 4, clientMessageId: 'a', body: 'uno' });
    const conflicto = await send({ clientSequence: 4, clientMessageId: 'b', body: 'dos' });
    const payload = (await conflicto.json()) as { code: string };

    expect(conflicto.status).toBe(409);
    expect(payload.code).toBe('CLIENT_SEQUENCE_CONFLICT');
    expect(await countRows('messages')).toBe(1);
  });

  it('404 si la conversacion no existe', async () => {
    const response = await send({ conversationId: randomUUID() });
    const payload = (await response.json()) as { code: string };

    expect(response.status).toBe(404);
    expect(payload.code).toBe('SENDER_NOT_IN_CONVERSATION');
  });

  it('400 si falta el header Idempotency-Key', async () => {
    const response = await fetch(
      `${baseUrl}/v1/conversations/${fixture.conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          senderId: fixture.ownerId,
          senderDeviceId: fixture.senderDeviceId,
          clientMessageId: 'local-1',
          clientSequence: 1,
          body: 'hola',
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('INVALID_REQUEST');
  });

  it('400 si clientSequence viene como string: "1" y 1 no son el mismo pedido', async () => {
    const response = await fetch(
      `${baseUrl}/v1/conversations/${fixture.conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
        body: JSON.stringify({
          senderId: fixture.ownerId,
          senderDeviceId: fixture.senderDeviceId,
          clientMessageId: 'local-1',
          clientSequence: '1',
          body: 'hola',
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await countRows('messages')).toBe(0);
  });

  it('C1 sobre HTTP — 100 requests concurrentes con la misma key dejan un mensaje', async () => {
    const key = `key-${randomUUID()}`;

    const responses = await Promise.all(Array.from({ length: 100 }, () => send({ key })));
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);

    // Ninguna respuesta inesperada: solo 201, replay o conflicto de operacion en curso.
    expect(statuses.every((status) => [200, 201, 409].includes(status))).toBe(true);

    // Los 409 tienen que ser IN_PROGRESS y traer Retry-After: sin eso el cliente
    // reintentaria en loop cerrado.
    const enCurso = responses.filter((response) => response.status === 409);
    for (const response of enCurso.slice(0, 5)) {
      expect(response.headers.get('retry-after')).toBeTruthy();
    }

    expect(await countRows('messages')).toBe(1);
    expect(await countRows('delivery_batches')).toBe(1);
    expect(await countRows('delivery_envelopes')).toBe(3);
  });
});

describe('GET /v1/messages/:messageId', () => {
  it('devuelve el mensaje publicado', async () => {
    const created = (await (await send()).json()) as { messageId: string };

    const response = await fetch(`${baseUrl}/v1/messages/${created.messageId}`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.messageId).toBe(created.messageId);
    expect(payload.serverSequence).toBe(1);
    expect(payload.body).toBe('hola');
  });

  it('404 si no existe', async () => {
    const response = await fetch(`${baseUrl}/v1/messages/${randomUUID()}`);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('MESSAGE_NOT_FOUND');
  });
});

describe('GET /v1/operations/:key — recuperacion sin reenviar el efecto', () => {
  it('devuelve el resultado persistido de la operacion', async () => {
    const key = `key-${randomUUID()}`;
    const created = (await (await send({ key })).json()) as { messageId: string };

    const response = await fetch(`${baseUrl}/v1/operations/${key}`, {
      headers: { 'x-actor-id': fixture.ownerId },
    });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('completed');
    expect(payload.recoveryPoint).toBe('completed');
    expect(payload.resourceId).toBe(created.messageId);
    expect(payload.responseStatus).toBe(201);
    expect((payload.responseBody as { messageId: string }).messageId).toBe(created.messageId);
  });

  it('404 si esa key no existe para ese actor', async () => {
    const response = await fetch(`${baseUrl}/v1/operations/inexistente`, {
      headers: { 'x-actor-id': fixture.ownerId },
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('OPERATION_NOT_FOUND');
  });
});
