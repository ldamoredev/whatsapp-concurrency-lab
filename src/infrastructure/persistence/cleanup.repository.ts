import type { Pool, PoolClient } from 'pg';

export type CleanupReason = 'completed' | 'expired';

export interface CleanedBatch {
  messageId: string;
  reason: CleanupReason;
  deletedEnvelopes: number;
}

/**
 * Reclama el derecho a limpiar UN batch, y lo limpia.
 *
 * I10 — el cleanup final ocurre una sola vez.
 *
 * `AND cleanup_at IS NULL` es la puerta. Dos caminos compiten por ella: el ack que
 * completa el batch y el CronJob que barre. Pueden llegar al mismo tiempo, desde pods
 * distintos. El UPDATE condicional decide: uno se lleva la fila, el otro actualiza 0
 * filas y no borra nada.
 *
 * No hace falta un lock explicito ni un lider. El UPDATE bloquea la fila mientras
 * corre, y `cleanup_at IS NULL` deja de ser cierto en cuanto el ganador commitea.
 *
 * `WHERE completed_at IS NOT NULL OR expires_at < now()` es I9: no se limpia un batch
 * al que todavia le faltan dispositivos, salvo que haya vencido. Ademas del WHERE, la
 * constraint `delivery_batches_cleanup_requires_completion_or_expiry` lo exige en el
 * schema — si el WHERE tuviera un bug, el 23514 avisa en vez de perder entregas.
 *
 * El DELETE de envelopes va en la MISMA transaccion que la puerta: si estuvieran
 * separados y el proceso muriera en el medio, el batch quedaria marcado como limpio
 * con sus envelopes todavia ahi, y nadie los volveria a mirar.
 */
export async function cleanupBatch(
  client: PoolClient,
  messageId: string,
): Promise<CleanedBatch | null> {
  const claimed = await client.query<{ message_id: string; cleanup_reason: CleanupReason }>(
    `UPDATE delivery_batches
        SET cleanup_at = now(),
            cleanup_reason = CASE
              WHEN completed_at IS NOT NULL THEN 'completed'
              ELSE 'expired'
            END
      WHERE message_id = $1
        AND cleanup_at IS NULL
        AND (completed_at IS NOT NULL OR expires_at < now())
      RETURNING message_id, cleanup_reason`,
    [messageId],
  );

  if (claimed.rowCount === 0) {
    // O ya lo limpio otro, o todavia no corresponde. Las dos son respuestas normales.
    return null;
  }

  const deleted = await client.query('DELETE FROM delivery_envelopes WHERE message_id = $1', [
    messageId,
  ]);

  return {
    messageId,
    reason: claimed.rows[0].cleanup_reason,
    deletedEnvelopes: deleted.rowCount ?? 0,
  };
}

/**
 * Barrido masivo: el cuerpo del CronJob de cleanup.
 *
 * Mismo mecanismo que `cleanupBatch` pero sobre todos los batches elegibles a la vez.
 * `FOR UPDATE SKIP LOCKED` hace que dos workers concurrentes se repartan el trabajo en
 * vez de pelearse por las mismas filas: el segundo saltea las que el primero ya tiene
 * tomadas, en lugar de esperarlas.
 */
export async function cleanupEligibleBatches(
  client: PoolClient,
  limit = 100,
): Promise<CleanedBatch[]> {
  const claimed = await client.query<{ message_id: string; cleanup_reason: CleanupReason }>(
    `WITH elegibles AS (
       SELECT message_id
         FROM delivery_batches
        WHERE cleanup_at IS NULL
          AND (completed_at IS NOT NULL OR expires_at < now())
        ORDER BY created_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     )
     UPDATE delivery_batches b
        SET cleanup_at = now(),
            cleanup_reason = CASE
              WHEN b.completed_at IS NOT NULL THEN 'completed'
              ELSE 'expired'
            END
       FROM elegibles e
      WHERE b.message_id = e.message_id
      RETURNING b.message_id, b.cleanup_reason`,
    [limit],
  );

  if (claimed.rowCount === 0) {
    return [];
  }

  const messageIds = claimed.rows.map((row) => row.message_id);

  const deleted = await client.query<{ message_id: string }>(
    'DELETE FROM delivery_envelopes WHERE message_id = ANY($1::uuid[]) RETURNING message_id',
    [messageIds],
  );

  const deletedByMessage = new Map<string, number>();
  for (const row of deleted.rows) {
    deletedByMessage.set(row.message_id, (deletedByMessage.get(row.message_id) ?? 0) + 1);
  }

  return claimed.rows.map((row) => ({
    messageId: row.message_id,
    reason: row.cleanup_reason,
    deletedEnvelopes: deletedByMessage.get(row.message_id) ?? 0,
  }));
}

/**
 * Verificacion de I9 desde la base: batches limpiados con dispositivos pendientes.
 *
 * Tiene que devolver siempre cero. Se apoya en los receipts, que sobreviven al
 * cleanup: si los envelopes fueran la unica evidencia, esta consulta seria imposible
 * de escribir justo cuando hace falta.
 */
export async function findCleanupViolations(
  db: Pool | PoolClient,
): Promise<Array<{ messageId: string; expectedCount: number; reachedTerminal: number }>> {
  const result = await db.query<{
    message_id: string;
    expected_count: number;
    reached_terminal: string;
  }>(
    `SELECT b.message_id,
            b.expected_count,
            count(*) FILTER (WHERE r.state IN ('delivered', 'read'))::text AS reached_terminal
       FROM delivery_batches b
       JOIN delivery_receipts r ON r.message_id = b.message_id
      WHERE b.cleanup_reason = 'completed'
      GROUP BY b.message_id, b.expected_count
     HAVING count(*) FILTER (WHERE r.state IN ('delivered', 'read')) < b.expected_count`,
  );

  return result.rows.map((row) => ({
    messageId: row.message_id,
    expectedCount: row.expected_count,
    reachedTerminal: Number.parseInt(row.reached_terminal, 10),
  }));
}
