/**
 * Demo narrada de las carreras ATRAVESANDO REPLICAS.
 *
 *   npm run stack:up && npm run demo:replicas
 *
 * Las demos anteriores corrian contra un solo proceso. Esta manda las mismas carreras
 * contra tres replicas distintas, que es donde el problema existe de verdad: sin
 * estado compartido en la base, cada proceso creeria ser el primero.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';

const REPLICAS = ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'];

const CONVERSATION = 'aaaaaaaa-0000-4000-8000-00000000f11a';
const OWNER = 'cccccccc-0000-4000-8000-00000000f11a';
const DEVICES = [
  'dddddddd-0000-4000-8000-00000000f1a1',
  'dddddddd-0000-4000-8000-00000000f1b2',
  'dddddddd-0000-4000-8000-00000000f1c3',
];

const dim = (t: string): string => `\x1b[2m${t}\x1b[0m`;
const bold = (t: string): string => `\x1b[1m${t}\x1b[0m`;
const green = (t: string): string => `\x1b[32m${t}\x1b[0m`;
const yellow = (t: string): string => `\x1b[33m${t}\x1b[0m`;
const cyan = (t: string): string => `\x1b[36m${t}\x1b[0m`;

const paso = (n: string, t: string): void =>
  console.log(`\n${bold(`━━━ ${n} ${t} `.padEnd(78, '━'))}\n`);
const nota = (t: string): void => console.log(dim(`   ${t}`));

/**
 * Round-robin del lado del cliente.
 *
 * Es un sustituto EXPLICITO y temporal del balanceador: Compose no trae uno y el
 * alcance prohibe agregar Nginx. Con k3d, Traefik reparte de verdad contra una sola
 * URL y esta funcion desaparece.
 */
let siguiente = 0;
const proximaReplica = (): string => REPLICAS[siguiente++ % REPLICAS.length];

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

interface Respuesta {
  status: number;
  instance: string;
  payload: Record<string, unknown>;
}

async function enviar(url: string, key: string, clientSequence: number): Promise<Respuesta> {
  const response = await fetch(`${url}/v1/conversations/${CONVERSATION}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      senderId: OWNER,
      senderDeviceId: DEVICES[0],
      clientMessageId: `local-${clientSequence}`,
      clientSequence,
      body: `mensaje ${clientSequence}`,
    }),
  });

  return {
    status: response.status,
    instance: response.headers.get('x-instance-id') ?? '?',
    payload: (await response.json()) as Record<string, unknown>,
  };
}

async function verificarStack(): Promise<void> {
  for (const url of REPLICAS) {
    try {
      const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) {
        throw new Error(`${url} respondio ${response.status}`);
      }
    } catch {
      throw new Error(
        `No responde ${url}. Levanta las tres replicas con:  npm run stack:up`,
      );
    }
  }
}

function repartoPorReplica(instancias: string[]): void {
  const conteo = new Map<string, number>();
  for (const instancia of instancias) {
    conteo.set(instancia, (conteo.get(instancia) ?? 0) + 1);
  }

  for (const [instancia, total] of [...conteo.entries()].sort()) {
    const barra = '█'.repeat(Math.round((total / instancias.length) * 40));
    console.log(`     ${bold(instancia.padEnd(8))} ${cyan(barra)} ${total}`);
  }
}

async function main(): Promise<void> {
  await verificarStack();

  const pool = createPool(databaseOptions({ applicationName: 'demo-replicas' }));
  await seed(pool);

  try {
    console.log(bold('\n  DEMO — las carreras atravesando tres replicas'));
    nota('Tres procesos distintos, cada uno con su propia memoria. La unica autoridad');
    nota('compartida es PostgreSQL.');

    // ── 1 ────────────────────────────────────────────────────────────────────
    paso('1.', 'La MISMA idempotency key contra las tres replicas, en secuencia');
    const key = `K-${randomUUID()}`;
    for (let i = 0; i < 6; i += 1) {
      const r = await enviar(proximaReplica(), key, 1);
      const etiqueta =
        r.status === 201 ? green('201 creado') : r.status === 200 ? dim('200 replay') : yellow(`${r.status}`);
      console.log(
        `   ${dim('→')} ${bold(r.instance.padEnd(6))} ${etiqueta}   ` +
          dim(`messageId ${String(r.payload.messageId ?? '—').slice(0, 8)}`),
      );
    }
    console.log();
    nota('Una sola replica creo el mensaje. Las otras dos leyeron el resultado que');
    nota('aquella dejo en la base. Ninguna sabia de la existencia de las otras.');

    // ── 2 ────────────────────────────────────────────────────────────────────
    paso('2.', '90 requests CONCURRENTES con una key nueva, repartidos entre las tres');
    const keyCarrera = `K-${randomUUID()}`;
    const resultados = await Promise.all(
      Array.from({ length: 90 }, () => enviar(proximaReplica(), keyCarrera, 2)),
    );

    const creados = resultados.filter((r) => r.status === 201);
    const replays = resultados.filter((r) => r.status === 200);
    const enCurso = resultados.filter((r) => r.status === 409);

    console.log(`   ${green(`201 creado:  ${creados.length}`)}`);
    console.log(`   ${dim(`200 replay:  ${replays.length}`)}`);
    console.log(`   ${yellow(`409 en curso: ${enCurso.length}`)}`);
    console.log();
    console.log(`   ${dim('reparto de los 90 requests:')}`);
    repartoPorReplica(resultados.map((r) => r.instance));
    console.log();
    console.log(`   ${dim('la replica que gano la carrera:')} ${bold(creados[0]?.instance ?? '—')}`);

    // ── 3 ────────────────────────────────────────────────────────────────────
    paso('3.', 'La base al final');
    const conteo = await pool.query<{
      mensajes: string;
      operaciones: string;
      batches: string;
      envelopes: string;
    }>(`
      SELECT (SELECT count(*)::text FROM messages)               AS mensajes,
             (SELECT count(*)::text FROM idempotency_operations) AS operaciones,
             (SELECT count(*)::text FROM delivery_batches)       AS batches,
             (SELECT count(*)::text FROM delivery_envelopes)     AS envelopes
    `);
    const c = conteo.rows[0];
    console.log(
      `   mensajes ${bold(c.mensajes)}   operaciones ${bold(c.operaciones)}   ` +
        `batches ${bold(c.batches)}   envelopes ${bold(c.envelopes)}`,
    );
    console.log();
    nota('96 requests HTTP repartidos entre tres procesos → 2 mensajes, 2 batches.');
    nota('Exactamente los que correspondian.');

    // ── 4 ────────────────────────────────────────────────────────────────────
    paso('4.', 'Cuantos requests atendio cada replica, segun sus propias metricas');
    for (const url of REPLICAS) {
      const texto = await (await fetch(`${url}/metrics`)).text();
      const total = texto
        .split('\n')
        .filter((linea) => linea.startsWith('lab_http_requests_total{method="POST"'))
        .reduce((suma, linea) => suma + Number.parseFloat(linea.split(' ').pop() ?? '0'), 0);

      const instancia = /instance="([^"]+)"/.exec(texto)?.[1] ?? url;
      console.log(`   ${bold(instancia.padEnd(8))} ${dim('POST atendidos:')} ${total}`);
    }
    console.log();
    nota('Esta es la evidencia que el alcance pide: no hace falta un reparto perfecto,');
    nota('si evidencia de que al menos dos replicas procesaron las carreras criticas.');
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
