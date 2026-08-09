/**
 * Demo narrada de la politica de huecos.
 *
 *   npm run demo:huecos
 *
 * Un dispositivo manda 1, 3, 4 y despues el 2. Se ve como los adelantados quedan
 * esperando sin lugar en la conversacion, y como al llegar el que faltaba se publican
 * todos en cascada, en el orden del stream y no en el de llegada.
 */
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { ExpireGapsService } from '../src/application/expire-gaps.service';
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { DomainErrorFilter } from '../src/http/domain-error.filter';

const CONVERSATION = 'aaaaaaaa-0000-4000-8000-00000000beef';
const OWNER = 'cccccccc-0000-4000-8000-00000000beef';
const DEVICE_A = 'dddddddd-0000-4000-8000-0000000000a1';
const DEVICE_B = 'dddddddd-0000-4000-8000-0000000000b2';

const dim = (t: string): string => `\x1b[2m${t}\x1b[0m`;
const bold = (t: string): string => `\x1b[1m${t}\x1b[0m`;
const green = (t: string): string => `\x1b[32m${t}\x1b[0m`;
const yellow = (t: string): string => `\x1b[33m${t}\x1b[0m`;
const cyan = (t: string): string => `\x1b[36m${t}\x1b[0m`;

function paso(n: string, titulo: string): void {
  console.log(`\n${bold(`━━━ ${n} ${titulo} `.padEnd(78, '━'))}\n`);
}

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
  for (const device of [DEVICE_A, DEVICE_B]) {
    await pool.query('INSERT INTO devices (id, owner_id) VALUES ($1, $2)', [device, OWNER]);
    await pool.query(
      'INSERT INTO conversation_devices (conversation_id, device_id) VALUES ($1, $2)',
      [CONVERSATION, device],
    );
  }
}

/** La conversacion tal como la ve un lector, mas lo que espera sin ser visible. */
async function conversacion(pool: Pool): Promise<void> {
  const result = await pool.query<{
    client_sequence: string;
    server_sequence: string | null;
    status: string;
    body: string;
  }>(
    `SELECT client_sequence, server_sequence, status, body
       FROM messages WHERE conversation_id = $1
      ORDER BY server_sequence NULLS LAST, client_sequence`,
    [CONVERSATION],
  );

  console.log(`   ${dim('messages')}`);
  console.log(`   ${'client_seq'.padEnd(12)}${'server_seq'.padEnd(12)}${'estado'.padEnd(12)}texto`);
  for (const row of result.rows) {
    const visible = row.server_sequence !== null;
    const linea =
      `   ${row.client_sequence.padEnd(12)}${(row.server_sequence ?? '—').padEnd(12)}` +
      `${row.status.padEnd(12)}${row.body}`;
    console.log(visible ? linea : dim(linea));
  }

  const orden = result.rows
    .filter((row) => row.server_sequence !== null)
    .map((row) => row.body.replace('mensaje ', ''));
  console.log(
    `   ${dim('orden visible de la conversacion:')} ${orden.length > 0 ? cyan(orden.join(' → ')) : dim('(vacia)')}`,
  );
}

async function streamDe(pool: Pool): Promise<void> {
  const result = await pool.query<{
    next_client_sequence: string;
    state: string;
    gap_deadline: Date | null;
  }>(
    `SELECT next_client_sequence, state, gap_deadline
       FROM device_sequences WHERE conversation_id = $1 AND device_id = $2`,
    [CONVERSATION, DEVICE_A],
  );

  if (result.rows.length === 0) {
    console.log(`   ${dim('stream del dispositivo A: todavia no existe')}`);
    return;
  }

  const row = result.rows[0];
  const color = row.state === 'ok' ? green : yellow;
  console.log(
    `   ${dim('stream de A →')} espera client_sequence ${bold(row.next_client_sequence)}   ` +
      `estado ${color(row.state)}   ` +
      `${row.gap_deadline ? dim('deadline corriendo') : dim('sin deadline')}`,
  );
}

async function entrega(pool: Pool): Promise<void> {
  const result = await pool.query<{ batches: string; envelopes: string }>(
    `SELECT (SELECT count(*)::text FROM delivery_batches)   AS batches,
            (SELECT count(*)::text FROM delivery_envelopes) AS envelopes`,
  );
  console.log(
    `   ${dim('trabajo de entrega →')} ${result.rows[0].batches} batch(es), ` +
      `${result.rows[0].envelopes} envelope(s)`,
  );
}

async function enviar(baseUrl: string, clientSequence: number): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/conversations/${CONVERSATION}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `K-${clientSequence}-${Date.now()}`,
    },
    body: JSON.stringify({
      senderId: OWNER,
      senderDeviceId: DEVICE_A,
      clientMessageId: `local-${clientSequence}`,
      clientSequence,
      body: `mensaje ${clientSequence}`,
    }),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  const color = response.status === 201 ? green : response.status === 202 ? yellow : cyan;
  const etiqueta =
    response.status === 201
      ? 'publicado'
      : response.status === 202
        ? 'aceptado, pero esperando'
        : 'conflicto';

  console.log(
    `   ${dim('→')} envia client_sequence ${bold(String(clientSequence))}   ` +
      `${dim('←')} ${color(`HTTP ${response.status}`)} ${dim(etiqueta)}`,
  );

  if (typeof payload.drained === 'number' && payload.drained > 0) {
    console.log(`     ${cyan(`arrastro ${payload.drained} mensaje(s) que estaban esperando`)}`);
  }
  if (payload.code) {
    console.log(`     ${dim(JSON.stringify(payload))}`);
  }
}

async function main(): Promise<void> {
  // Huecos que vencen enseguida, para no esperar 30 s reales en la demo.
  process.env.GAP_TIMEOUT_MS = process.env.GAP_TIMEOUT_MS ?? '1';

  const pool = createPool(databaseOptions({ applicationName: 'demo-huecos' }));
  await seed(pool);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = await app.getUrl();

  try {
    console.log(bold('\n  DEMO — orden y huecos'));
    nota('El dispositivo A manda 1, 3, 4 y despues el 2. La red no respeta el orden.');

    paso('1.', 'Llega el 1: es el esperado');
    await enviar(baseUrl, 1);
    console.log();
    await conversacion(pool);
    console.log();
    await streamDe(pool);
    await entrega(pool);

    paso('2.', 'Llegan el 3 y el 4: adelantados');
    await enviar(baseUrl, 3);
    await enviar(baseUrl, 4);
    console.log();
    await conversacion(pool);
    console.log();
    await streamDe(pool);
    await entrega(pool);
    console.log();
    nota('Estan en la base pero NO en la conversacion: sin server_sequence y en gris.');
    nota('Y no generaron ni un envelope. Para los destinatarios todavia no existen.');
    nota('Publicarlos ahora los pondria delante del 2, que es lo que I6 prohibe.');

    paso('3.', 'Llega el 2, el que faltaba');
    await enviar(baseUrl, 2);
    console.log();
    await conversacion(pool);
    console.log();
    await streamDe(pool);
    await entrega(pool);
    console.log();
    nota('En UN solo commit se publicaron el 2, el 3 y el 4, con server_sequence');
    nota('consecutiva y en el orden del STREAM, no en el de llegada. El stream volvio');
    nota('a ok y el deadline desaparecio.');

    paso('4.', 'Un hueco que nadie completa');
    await enviar(baseUrl, 6);
    console.log();
    await streamDe(pool);
    console.log();
    nota('Falta el 5. El reloj del hueco esta corriendo. Ahora corre el barrido de');
    nota('expiracion — el futuro CronJob:');
    console.log();

    const expirados = await new ExpireGapsService(pool).run();
    console.log(`   ${yellow(`barrido: ${expirados.length} stream(s) pasaron a resync_required`)}`);
    console.log();
    await streamDe(pool);
    console.log();
    await conversacion(pool);
    console.log();
    nota('CLAVE: vencer el deadline NO publico el 6. "Ya espere bastante" nunca');
    nota('significa "publicalo igual": eso seria saltear el hueco en silencio.');

    paso('5.', 'El stream esta bloqueado');
    await enviar(baseUrl, 7);
    console.log();
    nota('El error le dice al cliente exactamente que reenviar: el client_sequence 5.');

    paso('6.', 'El cliente decide: "el 5 se perdio, sigo desde el 6"');
    const response = await fetch(
      `${baseUrl}/v1/conversations/${CONVERSATION}/devices/${DEVICE_A}/stream/resync`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromClientSequence: 6 }),
      },
    );
    console.log(
      `   ${dim('→')} POST .../stream/resync ${dim('{ fromClientSequence: 6 }')}   ` +
        `${dim('←')} ${green(`HTTP ${response.status}`)}`,
    );
    console.log();
    await conversacion(pool);
    console.log();
    await streamDe(pool);
    await entrega(pool);
    console.log();
    nota('El 6 se publico. La decision de saltar el hueco fue del CLIENTE, por un');
    nota('endpoint explicito — nunca del servidor por cansancio. El 5 no existe y el');
    nota('orden visible no lo inventa.');
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
