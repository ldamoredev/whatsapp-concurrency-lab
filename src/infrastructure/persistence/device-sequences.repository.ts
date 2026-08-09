import { DatabaseError, type Pool, type PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

const FOREIGN_KEY_VIOLATION = '23503';

export type StreamState = 'ok' | 'waiting_gap' | 'resync_required';

export interface DeviceStream {
  conversationId: string;
  deviceId: string;
  nextClientSequence: number;
  state: StreamState;
  gapDeadline: Date | null;
}

interface StreamRow {
  conversation_id: string;
  device_id: string;
  next_client_sequence: string;
  state: StreamState;
  gap_deadline: Date | null;
}

function toStream(row: StreamRow): DeviceStream {
  return {
    conversationId: row.conversation_id,
    deviceId: row.device_id,
    nextClientSequence: Number.parseInt(row.next_client_sequence, 10),
    state: row.state,
    gapDeadline: row.gap_deadline,
  };
}

/**
 * Toma el estado del stream de un dispositivo CON LOCK, creándolo si no existía.
 *
 * ORDEN DE LOCKS — importa:
 *   1. device_sequences      (este)
 *   2. conversation_sequences
 *
 * Siempre en ese orden, en todo el código. Dos transacciones que los tomaran al
 * revés se bloquearían mutuamente y Postgres mataría una con un deadlock. El orden
 * elegido es el natural: primero se decide SI el mensaje se publica (stream), y sólo
 * si se publica hace falta el orden visible (conversación).
 *
 * El `INSERT ... ON CONFLICT DO NOTHING` crea la fila la primera vez que ese
 * dispositivo escribe. No se puede lockear una fila que no existe, y dos primeros
 * mensajes concurrentes del mismo dispositivo intentarían crearla a la vez: el
 * ON CONFLICT convierte esa carrera en un no-op.
 */
export async function lockStream(
  client: PoolClient,
  conversationId: string,
  deviceId: string,
): Promise<DeviceStream | null> {
  // SAVEPOINT: `device_sequences` tiene FK a `conversations` y a `devices`. Si la
  // conversación o el dispositivo no existen, el INSERT falla con 23503 y dejaría la
  // transacción abortada — el cliente vería un 500 en vez del 404 que corresponde.
  await client.query('SAVEPOINT lock_stream');

  try {
    await client.query(
      `INSERT INTO device_sequences (conversation_id, device_id)
       VALUES ($1, $2)
       ON CONFLICT (conversation_id, device_id) DO NOTHING`,
      [conversationId, deviceId],
    );
    await client.query('RELEASE SAVEPOINT lock_stream');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT lock_stream');

    if (error instanceof DatabaseError && error.code === FOREIGN_KEY_VIOLATION) {
      return null;
    }
    throw error;
  }

  const result = await client.query<StreamRow>(
    `SELECT conversation_id, device_id, next_client_sequence, state, gap_deadline
       FROM device_sequences
      WHERE conversation_id = $1 AND device_id = $2
        FOR UPDATE`,
    [conversationId, deviceId],
  );

  return result.rows.length > 0 ? toStream(result.rows[0]) : null;
}

/** Lectura sin lock, para el endpoint de consulta del stream. */
export async function findStream(
  db: Queryable,
  conversationId: string,
  deviceId: string,
): Promise<DeviceStream | null> {
  const result = await db.query<StreamRow>(
    `SELECT conversation_id, device_id, next_client_sequence, state, gap_deadline
       FROM device_sequences
      WHERE conversation_id = $1 AND device_id = $2`,
    [conversationId, deviceId],
  );

  return result.rows.length > 0 ? toStream(result.rows[0]) : null;
}

/**
 * Marca que el stream está esperando un hueco.
 *
 * El deadline se fija SÓLO la primera vez: mide desde que apareció el hueco, no desde
 * el último mensaje que llegó. Si se reiniciara con cada mensaje adelantado, un
 * cliente que sigue mandando 5, 6, 7 mientras falta el 2 empujaría el vencimiento para
 * siempre y el hueco nunca expiraría.
 */
export async function markWaitingGap(
  client: PoolClient,
  conversationId: string,
  deviceId: string,
  gapTimeoutMs: number,
): Promise<void> {
  await client.query(
    `UPDATE device_sequences
        SET state = 'waiting_gap',
            gap_deadline = now() + make_interval(secs => $3::double precision)
      WHERE conversation_id = $1
        AND device_id = $2
        AND state = 'ok'`,
    [conversationId, deviceId, gapTimeoutMs / 1000],
  );
}

/**
 * Avanza el puntero del stream y lo deja sano.
 *
 * Se llama después de publicar y drenar: si ya no queda nada bufferizado, el hueco se
 * cerró y el deadline tiene que desaparecer — el CHECK
 * `device_sequences_gap_deadline_matches_state` no admite un deadline sin hueco.
 */
export async function advanceStream(
  client: PoolClient,
  conversationId: string,
  deviceId: string,
  nextClientSequence: number,
  stillBuffered: boolean,
  gapTimeoutMs: number,
): Promise<void> {
  if (stillBuffered) {
    await client.query(
      `UPDATE device_sequences
          SET next_client_sequence = $3,
              state = 'waiting_gap',
              gap_deadline = COALESCE(gap_deadline, now() + make_interval(secs => $4::double precision))
        WHERE conversation_id = $1 AND device_id = $2`,
      [conversationId, deviceId, nextClientSequence, gapTimeoutMs / 1000],
    );
    return;
  }

  await client.query(
    `UPDATE device_sequences
        SET next_client_sequence = $3,
            state = 'ok',
            gap_deadline = NULL
      WHERE conversation_id = $1 AND device_id = $2`,
    [conversationId, deviceId, nextClientSequence],
  );
}

/**
 * Barre los huecos vencidos.
 *
 * `state = 'waiting_gap' AND gap_deadline < now()` en el WHERE hace la operación
 * idempotente y segura para dos workers concurrentes: el segundo no encuentra filas
 * que ya cambiaron de estado. El `now()` es el reloj de PostgreSQL, no el del worker.
 *
 * Es el cuerpo del CronJob de expiración; hoy se invoca a mano o desde los tests.
 */
export async function expireOverdueGaps(db: Queryable): Promise<DeviceStream[]> {
  const result = await db.query<StreamRow>(
    `UPDATE device_sequences
        SET state = 'resync_required',
            gap_deadline = NULL
      WHERE state = 'waiting_gap'
        AND gap_deadline < now()
      RETURNING conversation_id, device_id, next_client_sequence, state, gap_deadline`,
  );

  return result.rows.map(toStream);
}

/**
 * Resync explícito: el cliente declara desde qué client_sequence va a seguir.
 *
 * Es el ÚNICO camino para saltar un hueco, y es del cliente, no del servidor. El
 * servidor nunca decide por su cuenta "ya esperé bastante, sigo de largo": eso sería
 * publicar en silencio un stream con un agujero.
 */
export async function resyncStream(
  client: PoolClient,
  conversationId: string,
  deviceId: string,
  fromClientSequence: number,
): Promise<void> {
  await client.query(
    `UPDATE device_sequences
        SET next_client_sequence = $3,
            state = 'ok',
            gap_deadline = NULL
      WHERE conversation_id = $1 AND device_id = $2`,
    [conversationId, deviceId, fromClientSequence],
  );
}
