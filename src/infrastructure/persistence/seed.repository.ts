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
  /**
   * Dispositivos de la PRIMERA conversacion, la "caliente". Por defecto, los mismos
   * que las demas.
   *
   * Existe porque L1 pide al menos una conversacion caliente, y el calor no se puede
   * fabricar mandando mas trafico a la misma: el orden se asigna por
   * (conversacion, dispositivo), asi que dos generadores sobre el MISMO stream se
   * pisan el client_sequence y producen conflictos que no tienen nada que ver con la
   * carga. El calor de verdad es estructural: muchos dispositivos distintos —cada uno
   * con su propio stream— compitiendo por la UNICA fila de `conversation_sequences`
   * de esa conversacion, que es donde esta el `SELECT ... FOR UPDATE`.
   */
  hotDevices?: number;
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
    // La conversacion 0 es la caliente, por convencion estable: asi dos corridas
    // distintas calientan la MISMA y son comparables.
    const cuantos = c === 0 ? (options.hotDevices ?? options.devices) : options.devices;

    for (let d = 0; d < cuantos; d += 1) {
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
 * Borra el TRAFICO de estas conversaciones, dejando la poblacion intacta.
 *
 * Existe por un hallazgo que casi arruina la medicion de S8 sin dar ningun error.
 * La `Idempotency-Key` de una corrida de carga es determinista a proposito, asi que
 * la SEGUNDA corrida contra los mismos streams no crea nada: encuentra la respuesta
 * guardada y la repite. No falla, no se queja, y el p95 mejora muchisimo — porque un
 * replay es un SELECT y una creacion es una transaccion con lock del contador de la
 * conversacion. Medido: segunda corrida, 49 replays y 0 creados, con la base clavada
 * en 600 mensajes. Comparar ese p95 contra el de la primera corrida seria comparar
 * dos operaciones distintas creyendo que son la misma.
 *
 * Por eso una corrida repetible necesita streams virgenes, no solo la poblacion.
 *
 * Es un borrado ACOTADO a las conversaciones del prefijo: no es `TRUNCATE`, no toca
 * datos de otro prefijo, y no borra conversaciones ni dispositivos —esos son la
 * poblacion, y volver a crearlos cambiaria los ids—. El orden respeta las claves
 * foraneas: receipts y envelopes antes que batches, batches antes que messages.
 */
export async function resetTraffic(pool: Pool, options: SeedOptions): Promise<void> {
  const plan = planFor(options);
  const conversationIds = plan.map((conversation) => conversation.conversationId);
  const ownerIds = plan.map((conversation) => conversation.ownerId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const scopedMessages = `SELECT id FROM messages WHERE conversation_id = ANY($1::uuid[])`;

    await client.query(
      `DELETE FROM delivery_receipts WHERE message_id IN (${scopedMessages})`,
      [conversationIds],
    );
    await client.query(
      `DELETE FROM delivery_envelopes WHERE message_id IN (${scopedMessages})`,
      [conversationIds],
    );
    await client.query(
      `DELETE FROM delivery_batches WHERE message_id IN (${scopedMessages})`,
      [conversationIds],
    );
    await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])', [
      conversationIds,
    ]);
    await client.query('DELETE FROM device_sequences WHERE conversation_id = ANY($1::uuid[])', [
      conversationIds,
    ]);

    // Sin esto, la corrida siguiente manda las mismas keys y recibe replays.
    await client.query('DELETE FROM idempotency_operations WHERE actor_id = ANY($1::uuid[])', [
      ownerIds,
    ]);

    // El contador de orden vuelve al principio: si no, cada corrida arranca en un
    // server_sequence distinto y dos corridas dejan de ser comparables fila a fila.
    await client.query(
      `UPDATE conversation_sequences
          SET next_server_sequence = 1, version = 0
        WHERE conversation_id = ANY($1::uuid[])`,
      [conversationIds],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
