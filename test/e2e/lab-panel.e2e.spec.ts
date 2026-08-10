import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap';
import { testDatabaseOptions } from '../../src/infrastructure/database/config';
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

describe('el panel se sirve desde la propia API', () => {
  it('sirve una pagina por escenario', async () => {
    for (const [ruta, titulo] of [
      ['/', 'Tres procesos'],
      ['/idempotencia', 'Idempotencia'],
      ['/probar', 'Banco de pruebas'],
      ['/orden', 'Orden y huecos'],
      ['/entrega', 'Entrega multi-dispositivo'],
      ['/infra', 'Réplicas y base'],
    ]) {
      const response = await fetch(`${baseUrl}${ruta}`);
      expect(response.status, `ruta ${ruta}`).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text(), `ruta ${ruta}`).toContain(titulo);
    }
  });

  it('sirve el CSS y los modulos JS con su content-type', async () => {
    const css = await fetch(`${baseUrl}/panel.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    for (const modulo of [
      '/lib.js',
      '/idempotencia.js',
      '/probar.js',
      '/orden.js',
      '/entrega.js',
      '/infra.js',
    ]) {
      const response = await fetch(`${baseUrl}${modulo}`);
      expect(response.status, `modulo ${modulo}`).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
    }
  });

  it('no expone rutas fuera del mapa fijo', async () => {
    // El controller declara un mapa cerrado de rutas: no hay path variable que
    // sanitizar, asi que un traversal no tiene por donde entrar.
    for (const ruta of ['/../package.json', '/panel.css/../../.env', '/no-existe.js']) {
      const response = await fetch(`${baseUrl}${ruta}`);
      expect([404, 400], `ruta ${ruta} devolvio ${response.status}`).toContain(response.status);
    }
  });

  it('responde CORS para que el panel hable con las otras replicas', async () => {
    // El panel se sirve desde una replica y manda requests a las otras dos, en puertos
    // distintos. Sin CORS el navegador bloquea justo lo que se quiere demostrar.
    const response = await fetch(`${baseUrl}/lab/state`, {
      headers: { origin: 'http://localhost:3002' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
    // Y el header de instancia tiene que ser legible desde JS cross-origin.
    expect(response.headers.get('access-control-expose-headers')).toContain('X-Instance-Id');
  });
});

describe('endpoints de laboratorio', () => {
  it('reset crea una conversacion con la cantidad pedida de dispositivos', async () => {
    const response = await fetch(`${baseUrl}/lab/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCount: 4 }),
    });
    const payload = (await response.json()) as { deviceIds: string[]; conversationId: string };

    expect(response.status).toBe(201);
    expect(payload.deviceIds).toHaveLength(4);
    expect(payload.conversationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('acota deviceCount a un rango razonable', async () => {
    const response = await fetch(`${baseUrl}/lab/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCount: 999 }),
    });
    const payload = (await response.json()) as { deviceIds: string[] };

    // Cae al default en vez de crear 999 dispositivos.
    expect(payload.deviceIds).toHaveLength(3);
  });

  it('state devuelve el snapshot con los contadores y las invariantes', async () => {
    await fetch(`${baseUrl}/lab/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCount: 3 }),
    });

    const response = await fetch(`${baseUrl}/lab/state`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.instanceId).toBeTruthy();
    expect(payload.fixture).toBeTruthy();
    expect(payload.counts).toMatchObject({ messages: 0, operations: 0 });
    // La verificacion de invariantes corre contra la base y tiene que dar vacio.
    expect(payload.invariantViolations).toEqual([]);
  });

  it('el fingerprint no depende del orden de los campos, pero sí del contenido', async () => {
    const pedido = {
      conversationId: 'aaaa',
      senderId: 'bbbb',
      senderDeviceId: 'cccc',
      clientMessageId: 'local-1',
      clientSequence: 1,
      body: 'hola',
    };

    const calcular = async (cuerpo: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}/lab/fingerprint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      return (await response.json()) as { fingerprint: string; canonical: string };
    };

    const original = await calcular(pedido);
    // Mismos campos, otro orden de escritura: el fingerprint tiene que ser identico,
    // o un reintento legitimo se veria como conflicto.
    const reordenado = await calcular({
      body: pedido.body,
      clientSequence: pedido.clientSequence,
      clientMessageId: pedido.clientMessageId,
      senderDeviceId: pedido.senderDeviceId,
      senderId: pedido.senderId,
      conversationId: pedido.conversationId,
    });
    const otroTexto = await calcular({ ...pedido, body: 'chau' });

    expect(reordenado.fingerprint).toBe(original.fingerprint);
    expect(otroTexto.fingerprint).not.toBe(original.fingerprint);
    expect(original.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // La cadena canonica se expone para que el panel muestre QUE se hashea.
    expect(original.canonical).toContain('"body":"hola"');
  });

  it('los barridos son invocables y responden que hicieron', async () => {
    const gaps = await fetch(`${baseUrl}/lab/expire-gaps?force=true`, { method: 'POST' });
    const cleanup = await fetch(`${baseUrl}/lab/cleanup-deliveries`, { method: 'POST' });

    expect(gaps.status).toBe(200);
    expect((await gaps.json()) as { expired: number }).toMatchObject({ expired: 0 });

    expect(cleanup.status).toBe(200);
    expect((await cleanup.json()) as { cleaned: number }).toMatchObject({ cleaned: 0 });
  });
});
