import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Poblacion reproducible del laboratorio.
 *
 * Deja la base en un estado CONOCIDO para poder correr carga y comparar dos corridas.
 * Sin esto no hay medicion repetible: si cada corrida de k6 arranca contra una
 * poblacion distinta, la diferencia entre "antes de matar el pod" y "despues" no se
 * puede atribuir a la falla, porque tambien cambio el punto de partida.
 *
 * IDEMPOTENTE, y esa es la propiedad que importa. No borra nada y no supone empezar
 * en limpio: correrlo dos veces deja el mismo estado que correrlo una. Sale de dos
 * decisiones que van juntas y no sirven por separado:
 *
 *   1. Los identificadores NO son aleatorios: se derivan del prefijo y de la posicion.
 *      La conversacion 3 del prefijo "lab" tiene siempre el mismo uuid, en esta
 *      maquina y en la otra.
 *   2. Todos los INSERT llevan ON CONFLICT DO NOTHING, asi que la segunda corrida
 *      inserta cero filas y lo puede decir.
 *
 * NO es `POST /lab/reset`: aquel TRUNCA todo y arma una sola conversacion para mirar
 * una carrera en el panel. Este agrega sin destruir y sirve para carga.
 *
 * A proposito NO crea `device_sequences` ni mensajes: esas filas las escribe el
 * dominio al publicar el primer mensaje de cada stream. Un seed que las precargara
 * estaria falsificando justo el estado que el sistema tiene que construir solo.
 */

export interface SeedOptions {
  conversations: number;
  devices: number;
  prefix: string;
}

export interface SeededConversation {
  conversationId: string;
  ownerId: string;
  deviceIds: string[];
}

export interface SeedResult {
  options: SeedOptions;
  conversations: SeededConversation[];
  /** Filas realmente insertadas. En la segunda corrida son todas cero. */
  inserted: Record<string, number>;
}

/**
 * uuid determinista a partir de un texto.
 *
 * Es un UUID v5 (SHA-1 mas los bits de version y variante) tomando el prefijo como
 * espacio de nombres. Lo unico que se le pide es que sea una funcion: mismo texto,
 * mismo uuid, siempre. Con `randomUUID()` la segunda corrida duplicaria todo.
 */
export function deterministicUuid(...parts: string[]): string {
  const digest = createHash('sha1').update(parts.join(' ')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Que conversaciones y dispositivos corresponden a estas opciones, sin tocar la base. */
export function planFor(options: SeedOptions): SeededConversation[] {
  const plan: SeededConversation[] = [];

  for (let c = 0; c < options.conversations; c += 1) {
    const deviceIds: string[] = [];

    for (let d = 0; d < options.devices; d += 1) {
      deviceIds.push(deterministicUuid(options.prefix, 'device', String(c), String(d)));
    }

    plan.push({
      conversationId: deterministicUuid(options.prefix, 'conversation', String(c)),
      ownerId: deterministicUuid(options.prefix, 'owner', String(c)),
      deviceIds,
    });
  }

  return plan;
}

/**
 * Escribe el plan en la base.
 *
 * Todo en UNA transaccion: un seed a medias es peor que ninguno, porque deja una
 * conversacion sin su fila de `conversation_sequences` y el primer envio falla con un
 * error que no menciona al seed por ningun lado.
 *
 * Un INSERT por tabla con `unnest`, no uno por fila: con 100 conversaciones y 3
 * dispositivos, la version ingenua serian 700 round-trips.
 */
export async function seedFixtures(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const plan = planFor(options);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const conversationIds = plan.map((conversation) => conversation.conversationId);

    const conversations = await client.query(
      `INSERT INTO conversations (id)
       SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
      [conversationIds],
    );

    const sequences = await client.query(
      `INSERT INTO conversation_sequences (conversation_id)
       SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
      [conversationIds],
    );

    const deviceIds = plan.flatMap((conversation) => conversation.deviceIds);
    const ownerIds = plan.flatMap((conversation) =>
      conversation.deviceIds.map(() => conversation.ownerId),
    );
    const membershipIds = plan.flatMap((conversation) =>
      conversation.deviceIds.map(() => conversation.conversationId),
    );

    const devices = await client.query(
      `INSERT INTO devices (id, owner_id)
       SELECT unnest($1::uuid[]), unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [deviceIds, ownerIds],
    );

    const memberships = await client.query(
      `INSERT INTO conversation_devices (conversation_id, device_id)
       SELECT unnest($1::uuid[]), unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [membershipIds, deviceIds],
    );

    await client.query('COMMIT');

    return {
      options,
      conversations: plan,
      inserted: {
        conversations: conversations.rowCount ?? 0,
        conversation_sequences: sequences.rowCount ?? 0,
        devices: devices.rowCount ?? 0,
        conversation_devices: memberships.rowCount ?? 0,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
