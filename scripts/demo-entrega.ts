/**
 * Demo narrada de la entrega multi-dispositivo.
 *
 *   npm run demo:entrega
 *
 * Tres dispositivos ackean un mensaje: duplicados, fuera de orden y concurrentes. Se ve
 * el trabajo de entrega bajar a cero y la evidencia quedar intacta.
 */
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { CleanupDeliveriesService } from '../src/application/cleanup-deliveries.service';
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { DomainErrorFilter } from '../src/http/domain-error.filter';

const CONVERSATION = 'aaaaaaaa-0000-4000-8000-0000000000de';
const OWNER = 'cccccccc-0000-4000-8000-0000000000de';
const DEVICES = [
  'dddddddd-0000-4000-8000-0000000000a1',
  'dddddddd-0000-4000-8000-0000000000b2',
  'dddddddd-0000-4000-8000-0000000000c3',
];
const NOMBRES = new Map(DEVICES.map((id, index) => [id, ['A', 'B', 'C'][index]]));

const dim = (t: string): string => `\x1b[2m${t}\x1b[0m`;
const bold = (t: string): string => `\x1b[1m${t}\x1b[0m`;
const green = (t: string): string => `\x1b[32m${t}\x1b[0m`;
const yellow = (t: string): string => `\x1b[33m${t}\x1b[0m`;
const cyan = (t: string): string => `\x1b[36m${t}\x1b[0m`;

const paso = (n: string, t: string): void =>
  console.log(`\n${bold(`━━━ ${n} ${t} `.padEnd(78, '━'))}\n`);
const nota = (t: string): void => console.log(dim(`   ${t}`));

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
  for (const device of DEVICES) {
    await pool.query('INSERT INTO devices (id, owner_id) VALUES ($1, $2)', [device, OWNER]);
    await pool.query(
      'INSERT INTO conversation_devices (conversation_id, device_id) VALUES ($1, $2)',
      [CONVERSATION, device],
    );
  }
}

async function estado(pool: Pool, messageId: string): Promise<void> {
  const recibos = await pool.query<{ device_id: string; state: string; version: string }>(
    `SELECT device_id, state, version::text AS version
       FROM delivery_receipts WHERE message_id = $1 ORDER BY device_id`,
    [messageId],
  );

  console.log(`   ${dim('delivery_receipts')}  ${dim('(la evidencia durable)')}`);
  for (const row of recibos.rows) {
    const color = row.state === 'pending' ? dim : row.state === 'read' ? cyan : green;
    console.log(
      `     dispositivo ${bold(NOMBRES.get(row.device_id) ?? '?')}   ` +
        `${color(row.state.padEnd(10))} ${dim(`v${row.version}`)}`,
    );
  }

  const batch = await pool.query<{
    expected_count: number;
    delivered_count: number;
    completed_at: Date | null;
    cleanup_reason: string | null;
    envelopes: string;
  }>(
    `SELECT b.expected_count, b.delivered_count, b.completed_at, b.cleanup_reason,
            (SELECT count(*)::text FROM delivery_envelopes e WHERE e.message_id = b.message_id) AS envelopes
       FROM delivery_batches b WHERE b.message_id = $1`,
    [messageId],
  );

  const row = batch.rows[0];
  console.log(
    `   ${dim('batch →')} progreso ${bold(`${row.delivered_count}/${row.expected_count}`)}   ` +
      `${row.completed_at ? green('completo') : yellow('incompleto')}   ` +
      `${dim(`razon de cleanup: ${row.cleanup_reason ?? '—'}`)}`,
  );
  const pendiente = Number.parseInt(row.envelopes, 10);
  console.log(
    `   ${dim('trabajo de entrega →')} ` +
      (pendiente > 0
        ? yellow(`${pendiente} envelope(s) pendientes`)
        : green('0 envelopes — liberado')),
  );
}

async function ack(
  baseUrl: string,
  messageId: string,
  deviceId: string,
  state: 'delivered' | 'read',
  comentario = '',
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages/${messageId}/acks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, state }),
  });
  const payload = (await response.json()) as {
    advanced?: boolean;
    state?: string;
    code?: string;
    batch?: { cleanedUp: boolean };
  };

  if (payload.code) {
    console.log(
      `   ${dim('→')} ${bold(NOMBRES.get(deviceId) ?? '?')} ackea ${state}   ` +
        `${dim('←')} ${yellow(`HTTP ${response.status}`)} ${dim(payload.code)}`,
    );
    return;
  }

  const efecto = payload.advanced
    ? green(`avanzo a ${payload.state}`)
    : dim(`sin efecto (ya estaba en ${payload.state})`);

  console.log(
    `   ${dim('→')} ${bold(NOMBRES.get(deviceId) ?? '?')} ackea ${state.padEnd(9)}   ` +
      `${dim('←')} HTTP ${response.status}  ${efecto}` +
      (comentario ? dim(`   ${comentario}`) : ''),
  );

  if (payload.batch?.cleanedUp) {
    console.log(`     ${cyan('este ack completo el batch y libero el trabajo de entrega')}`);
  }
}

async function main(): Promise<void> {
  const pool = createPool(databaseOptions({ applicationName: 'demo-entrega' }));
  await seed(pool);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = await app.getUrl();

  try {
    console.log(bold('\n  DEMO — entrega multi-dispositivo'));
    nota('Un mensaje, tres dispositivos (A, B y C). Los acks llegan como llegan.');

    const publicado = await fetch(`${baseUrl}/v1/conversations/${CONVERSATION}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `K-${randomUUID()}` },
      body: JSON.stringify({
        senderId: OWNER,
        senderDeviceId: DEVICES[0],
        clientMessageId: 'local-1',
        clientSequence: 1,
        body: 'hola',
      }),
    });
    const messageId = ((await publicado.json()) as { messageId: string }).messageId;

    paso('0.', 'El mensaje se publico: snapshot de 3 destinatarios');
    await estado(pool, messageId);
    console.log();
    nota('El snapshot quedo congelado en 3. Agregar un dispositivo ahora no lo mueve.');

    paso('1.', 'A lee el mensaje directamente, sin pasar por "entregado"');
    await ack(baseUrl, messageId, DEVICES[0], 'read');
    console.log();
    await estado(pool, messageId);
    console.log();
    nota('El recibo salto a `read`, pero delivered_at se completo solo: el CHECK del');
    nota('schema no admite un mensaje leido que nunca llego.');

    paso('2.', 'A reintenta con acks viejos y duplicados');
    await ack(baseUrl, messageId, DEVICES[0], 'delivered', '(ack atrasado)');
    await ack(baseUrl, messageId, DEVICES[0], 'read', '(duplicado)');
    console.log();
    await estado(pool, messageId);
    console.log();
    nota('Ninguno movio nada. El estado no retrocedio (I7) y el progreso no subio dos');
    nota('veces (I8). Fijate que la version del recibo de A sigue en 1: no hubo');
    nota('escritura, no solo "no hubo cambio visible".');

    paso('3.', 'B confirma la entrega');
    await ack(baseUrl, messageId, DEVICES[1], 'delivered');
    console.log();
    await estado(pool, messageId);
    console.log();
    nota('2 de 3. C sigue sin aparecer, asi que los envelopes NO se limpian: I9.');

    paso('4.', 'C ackea 10 veces a la vez, y el CronJob corre en paralelo');
    const cron = new CleanupDeliveriesService(pool);
    await Promise.all([
      ...Array.from({ length: 10 }, () =>
        fetch(`${baseUrl}/v1/messages/${messageId}/acks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: DEVICES[2], state: 'delivered' }),
        }),
      ),
      ...Array.from({ length: 5 }, () => cron.run()),
    ]);
    console.log(`   ${dim('10 acks concurrentes de C + 5 corridas del CronJob, todo a la vez')}`);
    console.log();
    await estado(pool, messageId);
    console.log();
    nota('3 de 3, completo, y el trabajo de entrega liberado UNA sola vez (I10): dos');
    nota('caminos competian por la misma puerta (cleanup_at IS NULL) y solo uno paso.');

    paso('5.', 'Lo que queda despues del cleanup');
    const restos = await pool.query<{ envelopes: string; receipts: string; batches: string }>(
      `SELECT (SELECT count(*)::text FROM delivery_envelopes) AS envelopes,
              (SELECT count(*)::text FROM delivery_receipts)  AS receipts,
              (SELECT count(*)::text FROM delivery_batches)   AS batches`,
    );
    const r = restos.rows[0];
    console.log(
      `   envelopes ${bold(r.envelopes)}   receipts ${bold(r.receipts)}   batches ${bold(r.batches)}`,
    );
    console.log();
    nota('El trabajo desaparecio. La evidencia no. Por eso son tablas distintas: si el');
    nota('estado de entrega viviera en el envelope, el cleanup habria borrado justo lo');
    nota('que hace falta para auditar que el cleanup estuvo bien.');
    console.log();

    const violaciones = await cron.findViolations();
    console.log(
      violaciones.length === 0
        ? `   ${green('I9 verificada contra la base: 0 violaciones')}`
        : `   ${yellow(`I9 VIOLADA: ${violaciones.length}`)}`,
    );
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
