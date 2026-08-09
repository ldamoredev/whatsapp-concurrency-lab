import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpireGapsService } from '../../src/application/expire-gaps.service';
import { AppModule } from '../../src/app.module';
import { DomainErrorFilter } from '../../src/http/domain-error.filter';
import { testDatabaseOptions } from '../../src/infrastructure/database/config';
import { closeTestPool, countRows, testPool, truncateAll } from '../integration/helpers/database';
import {
  createConversationWithDevices,
  type ConversationFixture,
} from '../integration/helpers/fixtures';

let app: NestFastifyApplication;
let baseUrl: string;
let fixture: ConversationFixture;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseOptions().connectionString;
  // Huecos que vencen enseguida: si no, el test tendria que esperar 30 s reales.
  process.env.GAP_TIMEOUT_MS = '1';

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestPool();
  delete process.env.GAP_TIMEOUT_MS;
});

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

async function send(clientSequence: number): Promise<Response> {
  return fetch(`${baseUrl}/v1/conversations/${fixture.conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
    body: JSON.stringify({
      senderId: fixture.ownerId,
      senderDeviceId: fixture.senderDeviceId,
      clientMessageId: `local-${clientSequence}`,
      clientSequence,
      body: `mensaje ${clientSequence}`,
    }),
  });
}

const streamUrl = (): string =>
  `${baseUrl}/v1/conversations/${fixture.conversationId}/devices/${fixture.senderDeviceId}/stream`;

describe('POST messages — códigos según el orden', () => {
  it('201 el esperado, 202 el adelantado', async () => {
    const uno = await send(1);
    const tres = await send(3);

    expect(uno.status).toBe(201);
    expect(tres.status).toBe(202);

    const payload = (await tres.json()) as Record<string, unknown>;
    expect(payload.status).toBe('buffered');
    expect(payload.serverSequence).toBeNull();
    expect(payload.stream).toEqual({ state: 'waiting_gap', nextClientSequence: 2 });
  });

  it('al llegar el que falta, la respuesta dice cuántos arrastró', async () => {
    await send(1);
    await send(3);
    await send(4);

    const dos = await send(2);
    const payload = (await dos.json()) as Record<string, unknown>;

    expect(dos.status).toBe(201);
    expect(payload.serverSequence).toBe(2);
    expect(payload.drained).toBe(2);
    expect(payload.stream).toEqual({ state: 'ok', nextClientSequence: 5 });
  });
});

describe('GET .../stream — el cliente pregunta en qué quedó', () => {
  it('devuelve el próximo esperado y el estado', async () => {
    await send(1);
    await send(3);

    const response = await fetch(streamUrl());
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.nextClientSequence).toBe(2);
    expect(payload.state).toBe('waiting_gap');
    expect(payload.gapDeadline).not.toBeNull();
  });

  it('404 si ese dispositivo nunca escribió en esta conversación', async () => {
    const response = await fetch(streamUrl());

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('STREAM_NOT_FOUND');
  });
});

describe('el hueco vencido bloquea el stream', () => {
  it('409 STREAM_RESYNC_REQUIRED, y el error trae el próximo esperado', async () => {
    await send(1);
    await send(3);
    await new ExpireGapsService(testPool()).run();

    const response = await send(4);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.code).toBe('STREAM_RESYNC_REQUIRED');
    // Sin esto el cliente tendría que hacer otra request sólo para saber qué reenviar.
    expect(payload.nextClientSequence).toBe(2);

    // Y nada se publicó en silencio.
    const publicados = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE status = 'published'",
    );
    expect(publicados.rows[0].count).toBe('1');
  });

  it('reenviar el que faltaba destraba el stream', async () => {
    await send(1);
    await send(3);
    await new ExpireGapsService(testPool()).run();

    const dos = await send(2);
    expect(dos.status).toBe(201);
    expect(((await dos.json()) as { drained: number }).drained).toBe(1);

    const stream = (await (await fetch(streamUrl())).json()) as Record<string, unknown>;
    expect(stream.state).toBe('ok');
    expect(stream.nextClientSequence).toBe(4);
  });
});

describe('POST .../stream/resync — el contrato explícito', () => {
  it('el cliente declara desde dónde sigue y lo bufferizado se publica', async () => {
    await send(1);
    await send(3);
    await send(4);
    await new ExpireGapsService(testPool()).run();

    const response = await fetch(`${streamUrl()}/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromClientSequence: 3 }),
    });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.nextClientSequence).toBe(5);

    // Los tres publicados, y recién ahora con trabajo de entrega.
    const publicados = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE status = 'published'",
    );
    expect(publicados.rows[0].count).toBe('3');
    expect(await countRows('delivery_batches')).toBe(3);
  });

  it('409 INVALID_RESYNC si intenta retroceder', async () => {
    await send(1);
    await send(2);

    const response = await fetch(`${streamUrl()}/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromClientSequence: 1 }),
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('INVALID_RESYNC');
  });

  it('400 si fromClientSequence no es un entero', async () => {
    await send(1);

    const response = await fetch(`${streamUrl()}/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromClientSequence: '3' }),
    });

    expect(response.status).toBe(400);
  });
});
