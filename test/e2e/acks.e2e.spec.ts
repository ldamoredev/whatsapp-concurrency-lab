import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap';
import { testDatabaseOptions } from '../../src/infrastructure/database/config';
import { closeTestPool, countRows, testPool, truncateAll } from '../integration/helpers/database';
import {
  createConversationWithDevices,
  type ConversationFixture,
} from '../integration/helpers/fixtures';

let app: NestFastifyApplication;
let baseUrl: string;
let fixture: ConversationFixture;
let messageId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseOptions().connectionString;

  // La MISMA construccion que usa el server: si los e2e armaran la app a su manera,
  // estarian probando una aplicacion que no es la que corre en produccion.
  app = await createApp({ logger: false });
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

  const response = await fetch(`${baseUrl}/v1/conversations/${fixture.conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
    body: JSON.stringify({
      senderId: fixture.ownerId,
      senderDeviceId: fixture.senderDeviceId,
      clientMessageId: 'local-1',
      clientSequence: 1,
      body: 'hola',
    }),
  });
  messageId = ((await response.json()) as { messageId: string }).messageId;
});

const ack = (deviceId: string, state: 'delivered' | 'read'): Promise<Response> =>
  fetch(`${baseUrl}/v1/messages/${messageId}/acks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, state }),
  });

describe('POST /v1/messages/:messageId/acks', () => {
  it('200 y avanza el recibo', async () => {
    const response = await ack(fixture.deviceIds[0], 'delivered');
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.state).toBe('delivered');
    expect(payload.advanced).toBe(true);
    expect(payload.batch).toMatchObject({ expectedCount: 3, deliveredCount: 1, completed: false });
  });

  it('repetir el ack devuelve 2xx pero advanced=false', async () => {
    await ack(fixture.deviceIds[0], 'delivered');
    const segundo = await ack(fixture.deviceIds[0], 'delivered');
    const payload = (await segundo.json()) as Record<string, unknown>;

    expect(segundo.status).toBe(200);
    expect(payload.advanced).toBe(false);
    expect((payload.batch as { deliveredCount: number }).deliveredCount).toBe(1);
  });

  it('el ultimo ack completa el batch y libera el trabajo de entrega', async () => {
    await ack(fixture.deviceIds[0], 'delivered');
    await ack(fixture.deviceIds[1], 'read');
    const ultimo = await ack(fixture.deviceIds[2], 'delivered');
    const payload = (await ultimo.json()) as Record<string, unknown>;

    expect((payload.batch as { completed: boolean }).completed).toBe(true);
    expect((payload.batch as { cleanedUp: boolean }).cleanedUp).toBe(true);

    expect(await countRows('delivery_envelopes')).toBe(0);
    expect(await countRows('delivery_receipts')).toBe(3);
  });

  it('404 si el dispositivo no esta en el snapshot', async () => {
    const response = await ack(randomUUID(), 'delivered');

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('DEVICE_NOT_IN_SNAPSHOT');
  });

  it("400 si el state no es 'delivered' ni 'read'", async () => {
    const response = await fetch(`${baseUrl}/v1/messages/${messageId}/acks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: fixture.deviceIds[0], state: 'pending' }),
    });

    expect(response.status).toBe(400);
  });

  it('C4 sobre HTTP — 30 acks concurrentes de 3 dispositivos: un cleanup', async () => {
    const requests = fixture.deviceIds.flatMap((deviceId) =>
      Array.from({ length: 10 }, () => ack(deviceId, 'delivered')),
    );
    const responses = await Promise.all(requests);

    expect(responses.every((r) => r.status === 200)).toBe(true);

    const payloads = await Promise.all(responses.map((r) => r.json() as Promise<Record<string, unknown>>));
    // Exactamente tres movieron un recibo, y exactamente uno limpio.
    expect(payloads.filter((p) => p.advanced === true)).toHaveLength(3);
    expect(payloads.filter((p) => (p.batch as { cleanedUp: boolean }).cleanedUp)).toHaveLength(1);

    const estado = await testPool().query<{ delivered_count: number; cleanup_reason: string }>(
      'SELECT delivered_count, cleanup_reason FROM delivery_batches WHERE message_id = $1',
      [messageId],
    );
    expect(estado.rows[0].delivered_count).toBe(3);
    expect(estado.rows[0].cleanup_reason).toBe('completed');
    expect(await countRows('delivery_envelopes')).toBe(0);
  });
});

describe('GET /v1/messages/:messageId/receipts/:deviceId', () => {
  it('el recibo sobrevive al cleanup de envelopes', async () => {
    for (const deviceId of fixture.deviceIds) {
      await ack(deviceId, 'delivered');
    }
    expect(await countRows('delivery_envelopes')).toBe(0);

    const response = await fetch(
      `${baseUrl}/v1/messages/${messageId}/receipts/${fixture.deviceIds[0]}`,
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.state).toBe('delivered');
    expect(payload.deliveredAt).not.toBeNull();
  });
});
