import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module';

/**
 * La version INGENUA de cada operacion.
 *
 * Esto no es codigo malo escrito a proposito para que se vea mal: es el codigo que uno
 * escribe cuando todavia no penso en concurrencia. Se lee razonable, pasa el code
 * review, y funciona perfecto con un solo request a la vez.
 *
 * Corre contra las tablas espejo de la migracion 0006, que no tienen constraints. El
 * camino real del sistema no se toca nunca.
 *
 * Cada metodo tiene, en su comentario, la linea exacta donde esta la ventana.
 */
@Injectable()
export class NaiveService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async reset(): Promise<void> {
    await this.pool.query(
      'TRUNCATE naive_receipts, naive_batches, naive_messages, naive_operations',
    );
  }

  /**
   * Envio "idempotente" sin constraint: SELECT y despues INSERT.
   *
   *     SELECT ... WHERE key = $1     ← acá lee "no existe"
   *                                   ← ACÁ. Entre estas dos líneas entran los otros 59.
   *     INSERT INTO naive_operations  ← y los 60 insertan
   *
   * El chequeo previo se siente como una proteccion y no lo es: en READ COMMITTED,
   * ninguna transaccion ve la fila no commiteada de otra, asi que las 60 leen "no
   * existe" y las 60 crean el mensaje.
   */
  async send(input: {
    actorId: string;
    route: string;
    key: string;
    conversationId: string;
    senderDeviceId: string;
    clientSequence: number;
    body: string;
  }): Promise<{ created: boolean; messageId: string }> {
    // 1. "¿Ya existe esta key?"
    const existing = await this.pool.query<{ resource_id: string | null }>(
      'SELECT resource_id FROM naive_operations WHERE actor_id = $1 AND route = $2 AND key = $3 LIMIT 1',
      [input.actorId, input.route, input.key],
    );

    if (existing.rows.length > 0 && existing.rows[0].resource_id) {
      return { created: false, messageId: existing.rows[0].resource_id };
    }

    // ── LA VENTANA ────────────────────────────────────────────────────────────
    // Todo lo que pase entre el SELECT de arriba y el INSERT de abajo es invisible
    // para esta transaccion. No hace falta un `await` artificial para abrirla: el
    // round-trip a la base ya la abre. Con 60 requests concurrentes, decenas caen acá.

    // 2. "No existe, entonces lo creo."
    const messageId = randomUUID();

    await this.pool.query(
      `INSERT INTO naive_messages
         (id, conversation_id, sender_device_id, client_sequence, server_sequence, body)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [
        messageId,
        input.conversationId,
        input.senderDeviceId,
        input.clientSequence,
        input.body,
      ],
    );

    await this.pool.query(
      `INSERT INTO naive_operations (id, actor_id, route, key, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), input.actorId, input.route, input.key, messageId],
    );

    await this.pool.query(
      'INSERT INTO naive_batches (message_id, expected_count) VALUES ($1, $2)',
      [messageId, 3],
    );

    return { created: true, messageId };
  }

  /**
   * Publicacion sin politica de huecos: se publica apenas llega.
   *
   * No hay buffering ni chequeo contra el proximo esperado. El `server_sequence` se
   * asigna con un contador leido y escrito sin lock — pero incluso sin carrera, el
   * problema es de diseño: si los mensajes llegan 1, 3, 4, 2, la conversacion queda
   * en ese orden. El destinatario ve un salto y no tiene forma de saberlo.
   */
  async publishImmediately(input: {
    conversationId: string;
    senderDeviceId: string;
    clientSequence: number;
    body: string;
  }): Promise<{ messageId: string; serverSequence: number }> {
    const next = await this.pool.query<{ next: string }>(
      'SELECT coalesce(max(server_sequence), 0) + 1 AS next FROM naive_messages WHERE conversation_id = $1',
      [input.conversationId],
    );
    const serverSequence = Number.parseInt(next.rows[0].next, 10);
    const messageId = randomUUID();

    await this.pool.query(
      `INSERT INTO naive_messages
         (id, conversation_id, sender_device_id, client_sequence, server_sequence, body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        messageId,
        input.conversationId,
        input.senderDeviceId,
        input.clientSequence,
        serverSequence,
        input.body,
      ],
    );

    return { messageId, serverSequence };
  }

  /**
   * Ack sin update condicional: se escribe el estado y se suma al progreso.
   *
   *     INSERT INTO naive_receipts ...       ← un recibo por ACK, no por dispositivo
   *     UPDATE ... delivered_count + 1       ← suma por ack recibido, no por cambio real
   *
   * Los dos errores son el mismo error de fondo: contar EVENTOS en vez de contar
   * CAMBIOS DE ESTADO. Veinte acks del mismo dispositivo son veinte eventos y un solo
   * cambio, y el progreso tiene que reflejar lo segundo.
   */
  async ack(input: {
    messageId: string;
    deviceId: string;
    state: 'delivered' | 'read';
  }): Promise<{ deliveredCount: number; expectedCount: number }> {
    await this.pool.query(
      'INSERT INTO naive_receipts (id, message_id, device_id, state) VALUES ($1, $2, $3, $4)',
      [randomUUID(), input.messageId, input.deviceId, input.state],
    );

    const updated = await this.pool.query<{
      delivered_count: number;
      expected_count: number;
    }>(
      `UPDATE naive_batches
          SET delivered_count = delivered_count + 1
        WHERE message_id = $1
        RETURNING delivered_count, expected_count`,
      [input.messageId],
    );

    if (updated.rows.length === 0) {
      return { deliveredCount: 0, expectedCount: 0 };
    }

    return {
      deliveredCount: updated.rows[0].delivered_count,
      expectedCount: updated.rows[0].expected_count,
    };
  }

  /** Estado de las tablas espejo, para mostrar el destrozo al lado del camino real. */
  async state(): Promise<{
    messages: number;
    operations: number;
    duplicateStreamPositions: number;
    duplicateServerSequences: number;
    receipts: number;
    batches: Array<{ messageId: string; expectedCount: number; deliveredCount: number }>;
    order: Array<{ clientSequence: number; serverSequence: number | null; body: string }>;
  }> {
    const [counts, batches, order] = await Promise.all([
      this.pool.query<Record<string, string>>(`
        SELECT (SELECT count(*) FROM naive_messages)   AS messages,
               (SELECT count(*) FROM naive_operations) AS operations,
               (SELECT count(*) FROM naive_receipts)   AS receipts,
               (SELECT count(*) FROM (
                  SELECT 1 FROM naive_messages
                   GROUP BY conversation_id, sender_device_id, client_sequence
                  HAVING count(*) > 1) d)              AS dup_stream,
               (SELECT count(*) FROM (
                  SELECT 1 FROM naive_messages WHERE server_sequence IS NOT NULL
                   GROUP BY conversation_id, server_sequence
                  HAVING count(*) > 1) d)              AS dup_server
      `),
      this.pool.query<{ message_id: string; expected_count: number; delivered_count: number }>(
        'SELECT message_id, expected_count, delivered_count FROM naive_batches LIMIT 10',
      ),
      this.pool.query<{ client_sequence: string; server_sequence: string | null; body: string }>(
        `SELECT client_sequence, server_sequence, body
           FROM naive_messages ORDER BY server_sequence NULLS LAST LIMIT 20`,
      ),
    ]);

    const row = counts.rows[0];

    return {
      messages: Number.parseInt(row.messages, 10),
      operations: Number.parseInt(row.operations, 10),
      receipts: Number.parseInt(row.receipts, 10),
      duplicateStreamPositions: Number.parseInt(row.dup_stream, 10),
      duplicateServerSequences: Number.parseInt(row.dup_server, 10),
      batches: batches.rows.map((b) => ({
        messageId: b.message_id,
        expectedCount: b.expected_count,
        deliveredCount: b.delivered_count,
      })),
      order: order.rows.map((m) => ({
        clientSequence: Number.parseInt(m.client_sequence, 10),
        serverSequence: m.server_sequence === null ? null : Number.parseInt(m.server_sequence, 10),
        body: m.body,
      })),
    };
  }
}
