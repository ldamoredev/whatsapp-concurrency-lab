import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Creacion del snapshot de entrega.
 *
 * Las tres tablas se llenan en la MISMA transaccion que publica el mensaje. No hay un
 * momento en el que exista un mensaje publicado sin su snapshot: si lo hubiera, un
 * worker de entrega podria ver el mensaje y no saber a cuantos dispositivos hay que
 * entregarlo.
 */

export interface DeliverySnapshot {
  messageId: string;
  expectedCount: number;
  deviceIds: string[];
}

/**
 * Dispositivos que deben recibir el mensaje, congelados en este instante.
 *
 * Se excluyen los dados de baja (`removed_at IS NOT NULL`): un dispositivo que ya no
 * participa no genera trabajo de entrega. El emisor SI se incluye — en multi-device,
 * los otros dispositivos del mismo usuario tambien reciben, y ademas garantiza que
 * `expected_count >= 1`, que es lo que exige el CHECK del schema.
 */
export async function snapshotRecipients(
  client: PoolClient,
  conversationId: string,
): Promise<string[]> {
  const result = await client.query<{ device_id: string }>(
    `SELECT device_id
       FROM conversation_devices
      WHERE conversation_id = $1
        AND removed_at IS NULL
      ORDER BY device_id`,
    [conversationId],
  );

  return result.rows.map((row) => row.device_id);
}

/**
 * Crea el batch, un envelope y un receipt por dispositivo.
 *
 * Los envelopes y receipts se insertan con una sola sentencia cada uno usando
 * `unnest`: N round-trips a la base por dispositivo alargarian la transaccion, y esta
 * transaccion tiene tomado el lock del contador de la conversacion. Cuanto mas corta,
 * menos contencion en una conversacion caliente.
 */
export async function createDeliveries(
  client: PoolClient,
  messageId: string,
  deviceIds: string[],
  ttlMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_batches (message_id, expected_count, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))`,
    [messageId, deviceIds.length, ttlMs / 1000],
  );

  const envelopeIds = deviceIds.map(() => randomUUID());

  await client.query(
    `INSERT INTO delivery_envelopes (id, message_id, device_id, state)
     SELECT unnest($1::uuid[]), $2, unnest($3::uuid[]), 'pending'`,
    [envelopeIds, messageId, deviceIds],
  );

  await client.query(
    `INSERT INTO delivery_receipts (message_id, device_id, state)
     SELECT $1, unnest($2::uuid[]), 'pending'`,
    [messageId, deviceIds],
  );
}

export interface DeliveryProgress {
  expectedCount: number;
  deliveredCount: number;
  pendingEnvelopes: number;
}

/** Lectura para tests de invariantes y para el endpoint de consulta. */
export async function readDeliveryProgress(
  client: PoolClient,
  messageId: string,
): Promise<DeliveryProgress | null> {
  const result = await client.query<{
    expected_count: number;
    delivered_count: number;
    pending_envelopes: string;
  }>(
    `SELECT b.expected_count,
            b.delivered_count,
            (SELECT count(*) FROM delivery_envelopes e
              WHERE e.message_id = b.message_id AND e.state = 'pending')::text AS pending_envelopes
       FROM delivery_batches b
      WHERE b.message_id = $1`,
    [messageId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    expectedCount: result.rows[0].expected_count,
    deliveredCount: result.rows[0].delivered_count,
    pendingEnvelopes: Number.parseInt(result.rows[0].pending_envelopes, 10),
  };
}
