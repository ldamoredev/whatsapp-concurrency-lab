/**
 * Demo narrada del viaje de UN mensaje.
 *
 *   npm run demo
 *
 * Levanta la API de verdad, manda requests HTTP de verdad y despues de cada paso
 * muestra que quedo en cada tabla. La idea es ver la coreografia moverse, no leerla.
 *
 * Usa la base de DESARROLLO (DATABASE_URL) y la deja limpia al empezar.
 */
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { fingerprintOf } from '../src/domain/idempotency/fingerprint';
import { SEND_MESSAGE_ROUTE } from '../src/domain/idempotency/idempotency-operation';
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { DomainErrorFilter } from '../src/http/domain-error.filter';

const CONVERSATION = 'aaaaaaaa-0000-4000-8000-00000000cafe';
const OWNER = 'cccccccc-0000-4000-8000-00000000cafe';
const DEVICE_A = 'dddddddd-0000-4000-8000-0000000000a1';
const DEVICE_B = 'dddddddd-0000-4000-8000-0000000000b2';
const DEVICE_C = 'dddddddd-0000-4000-8000-0000000000c3';

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
const green = (text: string): string => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;

function paso(numero: string, titulo: string): void {
  console.log(`\n${bold(`━━━ ${numero} ${titulo} `.padEnd(78, '━'))}\n`);
}

function nota(texto: string): void {
  console.log(dim(`   ${texto}`));
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE delivery_receipts, delivery_envelopes, delivery_batches, messages,
             idempotency_operations, device_sequences, conversation_sequences,
             conversation_devices, devices, conversations CASCADE
  `);

  await pool.query('INSERT INTO conversations (id) VALUES ($1)', [CONVERSATION]);
  await pool.query('INSERT INTO conversation_sequences (conversation_id) VALUES ($1)', [
    CONVERSATION,
  ]);

  for (const device of [DEVICE_A, DEVICE_B, DEVICE_C]) {
    await pool.query('INSERT INTO devices (id, owner_id) VALUES ($1, $2)', [device, OWNER]);
    await pool.query(
      'INSERT INTO conversation_devices (conversation_id, device_id) VALUES ($1, $2)',
      [CONVERSATION, device],
    );
  }
}

/** Foto del estado: lo unico que prueba algo es la base, no la respuesta HTTP. */
async function foto(pool: Pool, titulo = 'estado de la base'): Promise<void> {
  const counters = await pool.query<{
    operaciones: string;
    mensajes: string;
    batches: string;
    envelopes: string;
    receipts: string;
    proximo: string;
  }>(`
    SELECT (SELECT count(*) FROM idempotency_operations)::text AS operaciones,
           (SELECT count(*) FROM messages)::text               AS mensajes,
           (SELECT count(*) FROM delivery_batches)::text       AS batches,
           (SELECT count(*) FROM delivery_envelopes)::text     AS envelopes,
           (SELECT count(*) FROM delivery_receipts)::text      AS receipts,
           (SELECT next_server_sequence::text FROM conversation_sequences LIMIT 1) AS proximo
  `);

  const row = counters.rows[0];
  console.log(`   ${dim(titulo)}`);
  console.log(
    `   ${'operaciones'.padEnd(12)}${'mensajes'.padEnd(10)}${'batches'.padEnd(9)}` +
      `${'envelopes'.padEnd(11)}${'receipts'.padEnd(10)}proximo server_sequence`,
  );
  console.log(
    `   ${row.operaciones.padEnd(12)}${row.mensajes.padEnd(10)}${row.batches.padEnd(9)}` +
      `${row.envelopes.padEnd(11)}${row.receipts.padEnd(10)}${row.proximo}`,
  );
}

async function mostrarOperaciones(pool: Pool): Promise<void> {
  const result = await pool.query<{
    key: string;
    status: string;
    recovery_point: string;
    attempt: number;
    resource_id: string | null;
    response_status: number | null;
  }>(
    `SELECT key, status, recovery_point, attempt, resource_id, response_status
       FROM idempotency_operations ORDER BY created_at`,
  );

  console.log(`   ${dim('idempotency_operations')}`);
  console.log(
    `   ${'key'.padEnd(8)}${'status'.padEnd(14)}${'recovery_point'.padEnd(16)}` +
      `${'attempt'.padEnd(9)}${'resource_id'.padEnd(14)}response`,
  );
  for (const row of result.rows) {
    console.log(
      `   ${row.key.padEnd(8)}${row.status.padEnd(14)}${row.recovery_point.padEnd(16)}` +
        `${String(row.attempt).padEnd(9)}${(row.resource_id?.slice(0, 8) ?? '—').padEnd(14)}` +
        `${row.response_status ?? '—'}`,
    );
  }
}

async function mostrarMensajes(pool: Pool): Promise<void> {
  const result = await pool.query<{
    id: string;
    client_sequence: string;
    server_sequence: string | null;
    status: string;
    body: string;
  }>(
    `SELECT id, client_sequence, server_sequence, status, body
       FROM messages ORDER BY server_sequence`,
  );

  console.log(`   ${dim('messages')}`);
  console.log(
    `   ${'id'.padEnd(11)}${'client_seq'.padEnd(12)}${'server_seq'.padEnd(12)}` +
      `${'status'.padEnd(12)}body`,
  );
  for (const row of result.rows) {
    console.log(
      `   ${row.id.slice(0, 8).padEnd(11)}${row.client_sequence.padEnd(12)}` +
        `${(row.server_sequence ?? '—').padEnd(12)}${row.status.padEnd(12)}${row.body}`,
    );
  }
}

async function mostrarEntrega(pool: Pool): Promise<void> {
  const result = await pool.query<{
    message_id: string;
    expected_count: number;
    delivered_count: number;
    envelopes: string;
    receipts: string;
  }>(
    `SELECT b.message_id, b.expected_count, b.delivered_count,
            (SELECT count(*)::text FROM delivery_envelopes e WHERE e.message_id = b.message_id) AS envelopes,
            (SELECT count(*)::text FROM delivery_receipts r  WHERE r.message_id = b.message_id) AS receipts
       FROM delivery_batches b ORDER BY b.created_at`,
  );

  console.log(`   ${dim('delivery_batches + su trabajo y sus recibos')}`);
  console.log(
    `   ${'message'.padEnd(11)}${'expected'.padEnd(10)}${'delivered'.padEnd(11)}` +
      `${'envelopes'.padEnd(11)}receipts`,
  );
  for (const row of result.rows) {
    console.log(
      `   ${row.message_id.slice(0, 8).padEnd(11)}${String(row.expected_count).padEnd(10)}` +
        `${String(row.delivered_count).padEnd(11)}${row.envelopes.padEnd(11)}${row.receipts}`,
    );
  }
}

interface EnvioOptions {
  key: string;
  clientSequence?: number;
  clientMessageId?: string;
  body?: string;
}

function pedidoDe(options: EnvioOptions) {
  return {
    senderId: OWNER,
    senderDeviceId: DEVICE_A,
    clientMessageId: options.clientMessageId ?? 'local-1',
    clientSequence: options.clientSequence ?? 1,
    body: options.body ?? 'hola',
  };
}

async function enviar(baseUrl: string, options: EnvioOptions): Promise<void> {
  const pedido = pedidoDe(options);

  const response = await fetch(`${baseUrl}/v1/conversations/${CONVERSATION}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': options.key },
    body: JSON.stringify(pedido),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  const replay = response.headers.get('x-idempotent-replay');
  const retryAfter = response.headers.get('retry-after');

  const color = response.status < 300 ? green : response.status < 500 ? yellow : red;
  console.log(
    `   ${dim('→')} POST .../messages  ${dim(`Idempotency-Key: ${options.key}`)}` +
      `  ${dim(`body: "${pedido.body}"`)}`,
  );
  console.log(
    `   ${dim('←')} ${color(`HTTP ${response.status}`)}` +
      (replay ? dim(`   replay=${replay}`) : '') +
      (retryAfter ? dim(`   Retry-After: ${retryAfter}s`) : ''),
  );
  console.log(`     ${dim(JSON.stringify(payload))}`);
}

async function main(): Promise<void> {
  const pool = createPool(databaseOptions({ applicationName: 'demo' }));
  await seed(pool);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = await app.getUrl();

  try {
    console.log(bold('\n  DEMO — el viaje de un mensaje'));
    nota('Una conversacion con 3 dispositivos. El dispositivo A va a mandar un mensaje.');

    paso('0.', 'Antes de empezar');
    await foto(pool, 'todo en cero, y el proximo lugar de la conversacion es el 1');

    paso('1.', 'El dispositivo A manda su mensaje (key K1)');
    await enviar(baseUrl, { key: 'K1' });
    console.log();
    await mostrarOperaciones(pool);
    console.log();
    await mostrarMensajes(pool);
    console.log();
    await mostrarEntrega(pool);
    console.log();
    nota('Un COMMIT creo TODO esto junto: la operacion cerrada con su respuesta, el');
    nota('mensaje ya publicado en el lugar 1, y el snapshot de entrega para los 3');
    nota('dispositivos. Nunca existio un instante con el mensaje pero sin sus envelopes.');
    console.log();
    await foto(pool, 'el contador de la conversacion ya avanzo al 2');

    paso('2.', 'Se corta la red. A no vio la respuesta y reintenta con la MISMA key');
    await enviar(baseUrl, { key: 'K1' });
    console.log();
    nota('HTTP 200 y replay=true: no ejecuto nada, leyo la respuesta que quedo guardada.');
    console.log();
    await foto(pool, 'nada se movio: mismo mensaje, mismos envelopes, mismo contador');

    paso('3.', 'A se confunde y manda OTRO texto con la MISMA key');
    await enviar(baseUrl, { key: 'K1', body: 'texto distinto' });
    console.log();
    nota('409 IDEMPOTENCY_KEY_REUSED. La foto del pedido no coincide con la guardada,');
    nota('asi que ni siquiera intenta: el mensaje original queda intacto.');
    console.log();
    await mostrarMensajes(pool);

    paso('4.', 'A reintenta pero PERDIO su key y genera una nueva (K2)');
    nota('Mismo clientSequence 1, mismo clientMessageId, mismo body. Key distinta.');
    console.log();
    await enviar(baseUrl, { key: 'K2' });
    console.log();
    nota('La key K2 es nueva, asi que la primera red (I1) no lo detecta. Lo atrapa la');
    nota('SEGUNDA red: el lugar 1 del stream de A ya esta ocupado por ese mismo mensaje,');
    nota('asi que en vez de duplicar, lo adopta y devuelve el messageId que ya existia.');
    console.log();
    await foto(pool, 'hay 2 operaciones, pero UN solo mensaje');
    console.log();
    await mostrarOperaciones(pool);

    paso('5.', 'Ahora A manda un mensaje nuevo de verdad (key K3, client_sequence 2)');
    await enviar(baseUrl, { key: 'K3', clientSequence: 2, clientMessageId: 'local-2', body: 'chau' });
    console.log();
    await mostrarMensajes(pool);
    console.log();
    nota('server_sequence 2: el contador de la conversacion se tomo con FOR UPDATE,');
    nota('se leyo, se uso y se incremento, todo bajo el mismo lock.');

    paso('6.', 'FENCING — un proceso reclama una key y se muere');
    const pedidoHuerfano = pedidoDe({ key: 'K9', clientSequence: 3, clientMessageId: 'local-3', body: 'huerfano' });
    await pool.query(
      `INSERT INTO idempotency_operations
         (id, actor_id, route, key, fingerprint, status, recovery_point, attempt, lease_until, expires_at)
       VALUES ($1, $2, $3, 'K9', $4, 'in_progress', 'started', 1,
               now() - interval '1 second', now() + interval '1 hour')`,
      [randomUUID(), OWNER, SEND_MESSAGE_ROUTE, fingerprintOf({ conversationId: CONVERSATION, ...pedidoHuerfano })],
    );
    nota('Simulado: la key K9 quedo reclamada, en curso, y su lease ya vencio.');
    console.log();
    await mostrarOperaciones(pool);
    console.log();
    nota('Ahora llega un retry del cliente con esa misma key K9...');
    console.log();
    await enviar(baseUrl, { key: 'K9', clientSequence: 3, clientMessageId: 'local-3', body: 'huerfano' });
    console.log();
    await mostrarOperaciones(pool);
    console.log();
    nota('K9 paso a attempt=2: el proceso nuevo cambio la cerradura y completo el');
    nota('trabajo. Si el proceso viejo reviviera e intentara cerrar con attempt=1, su');
    nota('UPDATE tocaria 0 filas y su efecto se descartaria con ROLLBACK.');

    paso('7.', 'Cuentas finales');
    await foto(pool);
    console.log();
    await mostrarMensajes(pool);
    console.log();
    await mostrarEntrega(pool);
    console.log();
    nota('4 operaciones idempotentes, 3 mensajes. Los 7 requests que se mandaron');
    nota('produjeron exactamente los efectos que correspondian, ni uno de mas.');
    console.log();
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo la demo: ${error.message}`);
  process.exitCode = 1;
});
