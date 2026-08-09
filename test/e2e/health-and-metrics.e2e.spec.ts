import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap';
import { testDatabaseOptions } from '../../src/infrastructure/database/config';
import { INSTANCE_ID } from '../../src/observability/instance';
import { lifecycle } from '../../src/observability/lifecycle';
import { closeTestPool } from '../integration/helpers/database';

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseOptions().connectionString;

  app = await createApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestPool();
});

describe('las tres probes tienen responsabilidades distintas', () => {
  it('startup consulta la base y marca el arranque terminado', async () => {
    const response = await fetch(`${baseUrl}/health/startup`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('started');
    expect(payload.instanceId).toBe(INSTANCE_ID);
  });

  it('liveness NO consulta la base', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('alive');
    expect(typeof payload.uptimeSeconds).toBe('number');
  });

  it('readiness responde 200 mientras la replica acepta trabajo', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('ready');
  });

  it('al drenar, readiness cae a 503 y liveness SIGUE en 200', async () => {
    lifecycle.startDraining();

    try {
      const ready = await fetch(`${baseUrl}/health/ready`);
      const live = await fetch(`${baseUrl}/health/live`);

      // Esta es la distincion que evita el desastre: durante una degradacion, el
      // balanceador saca la replica de rotacion pero Kubernetes no la reinicia.
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { status: string }).status).toBe('draining');
      expect(live.status).toBe(200);
    } finally {
      // Restaurar para no ensuciar el resto de la suite.
      (lifecycle as unknown as { draining: boolean }).draining = false;
    }
  });
});

describe('identidad de replica', () => {
  it('toda respuesta lleva X-Instance-Id, incluso los 404', async () => {
    const ok = await fetch(`${baseUrl}/health/live`);
    const notFound = await fetch(`${baseUrl}/v1/messages/${randomUUID()}`);

    expect(ok.headers.get('x-instance-id')).toBe(INSTANCE_ID);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-instance-id')).toBe(INSTANCE_ID);
  });
});

describe('/metrics', () => {
  it('expone el formato de Prometheus con la instancia como label', async () => {
    await fetch(`${baseUrl}/health/live`);

    const response = await fetch(`${baseUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain(`instance="${INSTANCE_ID}"`);
    expect(body).toContain('lab_http_requests_total');
    expect(body).toContain('lab_event_loop_lag_seconds');
    expect(body).toContain('lab_pg_pool_connections');
    expect(body).toContain('lab_ready');
  });

  it('usa la ruta CON parametros como label, nunca la URL concreta', async () => {
    const messageId = randomUUID();
    await fetch(`${baseUrl}/v1/messages/${messageId}`);

    const body = await (await fetch(`${baseUrl}/metrics`)).text();

    // La ruta parametrizada esta...
    expect(body).toContain('route="/v1/messages/:messageId"');
    // ...y el UUID concreto NO. Si estuviera, cada mensaje crearia una serie temporal
    // nueva y Prometheus moriria de cardinalidad.
    expect(body).not.toContain(messageId);
  });
});
