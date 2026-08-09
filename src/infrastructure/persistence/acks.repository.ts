import type { Pool, PoolClient } from 'pg';
import type { ReceiptState } from '../../domain/delivery/receipt-state';

type Queryable = Pool | PoolClient;

export interface StoredReceipt {
  messageId: string;
  deviceId: string;
  state: ReceiptState;
  deliveredAt: Date | null;
  readAt: Date | null;
  version: number;
}

interface ReceiptRow {
  message_id: string;
  device_id: string;
  state: ReceiptState;
  delivered_at: Date | null;
  read_at: Date | null;
  version: string;
}

function toReceipt(row: ReceiptRow): StoredReceipt {
  return {
    messageId: row.message_id,
    deviceId: row.device_id,
    state: row.state,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    version: Number.parseInt(row.version, 10),
  };
}

/**
 * Toma el recibo de ese dispositivo CON LOCK.
 *
 * El lock es por (mensaje, dispositivo): dos acks de dispositivos distintos sobre el
 * mismo mensaje NO se bloquean entre si. Solo se serializan los acks repetidos del
 * mismo dispositivo, que es exactamente la carrera que hay que ordenar.
 *
 * Devuelve `null` si ese dispositivo no esta en el snapshot del mensaje. Es la
 * respuesta correcta a "un dispositivo fuera del snapshot no cambia el batch": no hay
 * fila que tocar, y no hay que crearla.
 */
export async function lockReceipt(
  client: PoolClient,
  messageId: string,
  deviceId: string,
): Promise<StoredReceipt | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT message_id, device_id, state, delivered_at, read_at, version
       FROM delivery_receipts
      WHERE message_id = $1 AND device_id = $2
        FOR UPDATE`,
    [messageId, deviceId],
  );

  return result.rows.length > 0 ? toReceipt(result.rows[0]) : null;
}

/**
 * Avanza el recibo, y solo si de verdad avanza.
 *
 * I7 — un receipt nunca retrocede. Dos defensas superpuestas, a proposito:
 *
 *  1. `array_position(...) < array_position(...)` — la comparacion de estados vive en
 *     el WHERE, no en TypeScript. Aunque quien llame se equivoque, la base no deja
 *     retroceder.
 *  2. `AND version = $4` — el compare-and-set. Si otra transaccion movio el recibo
 *     entre la lectura y esta escritura, el UPDATE toca 0 filas.
 *
 * Con el `FOR UPDATE` previo la (2) es redundante dentro de la misma transaccion. Se
 * mantiene igual porque es lo que haria falta si mañana se decide sacar el lock
 * pesimista y pasar a optimismo con reintento — y porque documenta la intencion.
 *
 * Devolver 0 filas NO es un error: significa "el estado ya estaba igual o mas
 * adelante", que es la respuesta correcta a un ack duplicado o atrasado.
 */
export async function advanceReceipt(
  client: PoolClient,
  messageId: string,
  deviceId: string,
  nextState: ReceiptState,
  expectedVersion: number,
): Promise<StoredReceipt | null> {
  const result = await client.query<ReceiptRow>(
    `UPDATE delivery_receipts
        SET state        = $3,
            -- COALESCE: el primer timestamp gana. Un ack posterior no reescribe
            -- cuando ocurrio la entrega.
            delivered_at = COALESCE(delivered_at, now()),
            read_at      = CASE WHEN $3 = 'read' THEN COALESCE(read_at, now()) ELSE read_at END,
            version      = version + 1
      WHERE message_id = $1
        AND device_id = $2
        AND version = $4
        AND array_position(ARRAY['pending','delivered','read'], state)
          < array_position(ARRAY['pending','delivered','read'], $3::text)
      RETURNING message_id, device_id, state, delivered_at, read_at, version`,
    [messageId, deviceId, nextState, expectedVersion],
  );

  return result.rows.length > 0 ? toReceipt(result.rows[0]) : null;
}

/** Marca el envelope como entregado. El trabajo esta hecho; la fila se borra en el cleanup. */
export async function markEnvelopeDelivered(
  client: PoolClient,
  messageId: string,
  deviceId: string,
): Promise<void> {
  await client.query(
    `UPDATE delivery_envelopes
        SET state = 'delivered'
      WHERE message_id = $1 AND device_id = $2 AND state = 'pending'`,
    [messageId, deviceId],
  );
}

export interface BatchProgress {
  expectedCount: number;
  deliveredCount: number;
  completedAt: Date | null;
}

/**
 * Suma uno al progreso del batch y lo completa si con eso llega.
 *
 * I8 — un ack duplicado no incrementa dos veces el progreso.
 *
 * Esto se llama UNICAMENTE cuando el recibo cruzo el umbral terminal por primera vez,
 * en la misma transaccion que ese cambio. Atarlo al cambio real de estado — y no a
 * "llego un ack" — es lo que hace idempotente al conteo: 20 acks del mismo dispositivo
 * mueven el recibo una sola vez, asi que suman una sola vez.
 *
 * El CHECK `delivery_batches_delivered_not_above_expected` es la red debajo: si algun
 * dia un bug llamara a esto de mas, el 23514 avisa fuerte en vez de dejar que el
 * cleanup se dispare antes de tiempo.
 *
 * `completed_at` se setea en la misma sentencia, no en una segunda: entre las dos
 * habria una ventana en la que el batch esta completo pero no lo dice.
 */
export async function incrementDeliveredCount(
  client: PoolClient,
  messageId: string,
): Promise<BatchProgress> {
  const result = await client.query<{
    expected_count: number;
    delivered_count: number;
    completed_at: Date | null;
  }>(
    `UPDATE delivery_batches
        SET delivered_count = delivered_count + 1,
            completed_at = CASE
              WHEN delivered_count + 1 >= expected_count THEN COALESCE(completed_at, now())
              ELSE completed_at
            END
      WHERE message_id = $1
      RETURNING expected_count, delivered_count, completed_at`,
    [messageId],
  );

  const row = result.rows[0];
  return {
    expectedCount: row.expected_count,
    deliveredCount: row.delivered_count,
    completedAt: row.completed_at,
  };
}

export async function findBatchProgress(
  db: Queryable,
  messageId: string,
): Promise<BatchProgress | null> {
  const result = await db.query<{
    expected_count: number;
    delivered_count: number;
    completed_at: Date | null;
  }>(
    `SELECT expected_count, delivered_count, completed_at
       FROM delivery_batches WHERE message_id = $1`,
    [messageId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    expectedCount: row.expected_count,
    deliveredCount: row.delivered_count,
    completedAt: row.completed_at,
  };
}

export async function findReceipt(
  db: Queryable,
  messageId: string,
  deviceId: string,
): Promise<StoredReceipt | null> {
  const result = await db.query<ReceiptRow>(
    `SELECT message_id, device_id, state, delivered_at, read_at, version
       FROM delivery_receipts WHERE message_id = $1 AND device_id = $2`,
    [messageId, deviceId],
  );

  return result.rows.length > 0 ? toReceipt(result.rows[0]) : null;
}
