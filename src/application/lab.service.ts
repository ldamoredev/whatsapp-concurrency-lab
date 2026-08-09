import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module';
import { findCleanupViolations } from '../infrastructure/persistence/cleanup.repository';

/**
 * Soporte del panel de laboratorio.
 *
 * ATENCION: `reset()` TRUNCA todas las tablas. Estos endpoints existen para poder
 * provocar carreras y mirar la base en vivo; no tienen lugar en un despliegue real y
 * por eso el modulo se registra solo cuando `LAB_PANEL_ENABLED` no esta apagado.
 *
 * Todas las lecturas van contra la base, no contra memoria del proceso: el panel puede
 * estar hablando con una replica distinta de la que ejecuto la carrera, y ese es
 * justamente el punto.
 */

export interface LabFixture {
  conversationId: string;
  ownerId: string;
  deviceIds: string[];
}

export interface LabState {
  fixture: LabFixture | null;
  counts: Record<string, number>;
  conversation: { nextServerSequence: number; version: number } | null;
  messages: Array<{
    id: string;
    clientSequence: number;
    serverSequence: number | null;
    status: string;
    body: string;
    senderDeviceId: string;
  }>;
  streams: Array<{
    deviceId: string;
    nextClientSequence: number;
    state: string;
    gapDeadline: string | null;
  }>;
  batches: Array<{
    messageId: string;
    expectedCount: number;
    deliveredCount: number;
    completed: boolean;
    cleanupReason: string | null;
    pendingEnvelopes: number;
  }>;
  receipts: Array<{ messageId: string; deviceId: string; state: string; version: number }>;
  operations: Array<{
    key: string;
    status: string;
    attempt: number;
    responseStatus: number | null;
    resourceId: string | null;
  }>;
  invariantViolations: Array<{ invariant: string; detail: string }>;
}

@Injectable()
export class LabService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Borra todo y arma una conversacion nueva con `deviceCount` dispositivos. */
  async reset(deviceCount = 3): Promise<LabFixture> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`
        TRUNCATE delivery_receipts, delivery_envelopes, delivery_batches, messages,
                 idempotency_operations, device_sequences, conversation_sequences,
                 conversation_devices, devices, conversations CASCADE
      `);

      const conversationId = randomUUID();
      const ownerId = randomUUID();

      await client.query('INSERT INTO conversations (id) VALUES ($1)', [conversationId]);
      await client.query('INSERT INTO conversation_sequences (conversation_id) VALUES ($1)', [
        conversationId,
      ]);

      const deviceIds: string[] = [];
      for (let index = 0; index < deviceCount; index += 1) {
        const deviceId = randomUUID();
        await client.query('INSERT INTO devices (id, owner_id) VALUES ($1, $2)', [
          deviceId,
          ownerId,
        ]);
        await client.query(
          'INSERT INTO conversation_devices (conversation_id, device_id) VALUES ($1, $2)',
          [conversationId, deviceId],
        );
        deviceIds.push(deviceId);
      }

      await client.query('COMMIT');
      return { conversationId, ownerId, deviceIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Adelanta al pasado los deadlines de los huecos abiertos.
   *
   * Comodidad del panel: sin esto habria que esperar el `gapTimeoutMs` real para ver
   * un hueco vencer. NO modifica la logica del barrido — solo mueve el reloj de los
   * deadlines para que el barrido, sin cambios, los encuentre vencidos.
   */
  async forceGapDeadlines(): Promise<void> {
    await this.pool.query(
      `UPDATE device_sequences
          SET gap_deadline = now() - interval '1 second'
        WHERE state = 'waiting_gap'`,
    );
  }

  /** Snapshot completo para el panel. Una sola foto coherente de todo el estado. */
  async state(): Promise<LabState> {
    const fixture = await this.currentFixture();

    const [counts, conversation, messages, streams, batches, receipts, operations, violations] =
      await Promise.all([
        this.counts(),
        this.conversationCounter(fixture?.conversationId),
        this.messages(),
        this.streams(),
        this.batches(),
        this.receipts(),
        this.operations(),
        this.invariantViolations(),
      ]);

    return {
      fixture,
      counts,
      conversation,
      messages,
      streams,
      batches,
      receipts,
      operations,
      invariantViolations: violations,
    };
  }

  private async currentFixture(): Promise<LabFixture | null> {
    const result = await this.pool.query<{
      conversation_id: string;
      owner_id: string;
      device_ids: string[];
    }>(`
      SELECT c.id AS conversation_id,
             min(d.owner_id::text)::uuid AS owner_id,
             array_agg(d.id ORDER BY d.created_at) AS device_ids
        FROM conversations c
        JOIN conversation_devices cd ON cd.conversation_id = c.id
        JOIN devices d ON d.id = cd.device_id
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT 1
    `);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      conversationId: row.conversation_id,
      ownerId: row.owner_id,
      deviceIds: row.device_ids,
    };
  }

  private async counts(): Promise<Record<string, number>> {
    const result = await this.pool.query<Record<string, string>>(`
      SELECT (SELECT count(*) FROM messages)                                     AS messages,
             (SELECT count(*) FROM messages WHERE status = 'published')          AS published,
             (SELECT count(*) FROM messages WHERE status = 'buffered')           AS buffered,
             (SELECT count(*) FROM idempotency_operations)                       AS operations,
             (SELECT count(*) FROM delivery_batches)                             AS batches,
             (SELECT count(*) FROM delivery_batches WHERE cleanup_at IS NOT NULL) AS cleaned,
             (SELECT count(*) FROM delivery_envelopes)                           AS envelopes,
             (SELECT count(*) FROM delivery_receipts)                            AS receipts
    `);

    return Object.fromEntries(
      Object.entries(result.rows[0]).map(([key, value]) => [key, Number.parseInt(value, 10)]),
    );
  }

  private async conversationCounter(
    conversationId: string | undefined,
  ): Promise<{ nextServerSequence: number; version: number } | null> {
    if (!conversationId) {
      return null;
    }

    const result = await this.pool.query<{ next_server_sequence: string; version: string }>(
      'SELECT next_server_sequence, version FROM conversation_sequences WHERE conversation_id = $1',
      [conversationId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      nextServerSequence: Number.parseInt(result.rows[0].next_server_sequence, 10),
      version: Number.parseInt(result.rows[0].version, 10),
    };
  }

  private async messages(): Promise<LabState['messages']> {
    const result = await this.pool.query<{
      id: string;
      client_sequence: string;
      server_sequence: string | null;
      status: string;
      body: string;
      sender_device_id: string;
    }>(`
      SELECT id, client_sequence, server_sequence, status, body, sender_device_id
        FROM messages
       ORDER BY server_sequence NULLS LAST, client_sequence
       LIMIT 60
    `);

    return result.rows.map((row) => ({
      id: row.id,
      clientSequence: Number.parseInt(row.client_sequence, 10),
      serverSequence: row.server_sequence === null ? null : Number.parseInt(row.server_sequence, 10),
      status: row.status,
      body: row.body,
      senderDeviceId: row.sender_device_id,
    }));
  }

  private async streams(): Promise<LabState['streams']> {
    const result = await this.pool.query<{
      device_id: string;
      next_client_sequence: string;
      state: string;
      gap_deadline: Date | null;
    }>(`
      SELECT device_id, next_client_sequence, state, gap_deadline
        FROM device_sequences ORDER BY device_id
    `);

    return result.rows.map((row) => ({
      deviceId: row.device_id,
      nextClientSequence: Number.parseInt(row.next_client_sequence, 10),
      state: row.state,
      gapDeadline: row.gap_deadline?.toISOString() ?? null,
    }));
  }

  private async batches(): Promise<LabState['batches']> {
    const result = await this.pool.query<{
      message_id: string;
      expected_count: number;
      delivered_count: number;
      completed_at: Date | null;
      cleanup_reason: string | null;
      pending_envelopes: string;
    }>(`
      SELECT b.message_id, b.expected_count, b.delivered_count, b.completed_at, b.cleanup_reason,
             (SELECT count(*) FROM delivery_envelopes e WHERE e.message_id = b.message_id)::text
               AS pending_envelopes
        FROM delivery_batches b
        JOIN messages m ON m.id = b.message_id
       ORDER BY m.server_sequence NULLS LAST
       LIMIT 40
    `);

    return result.rows.map((row) => ({
      messageId: row.message_id,
      expectedCount: row.expected_count,
      deliveredCount: row.delivered_count,
      completed: row.completed_at !== null,
      cleanupReason: row.cleanup_reason,
      pendingEnvelopes: Number.parseInt(row.pending_envelopes, 10),
    }));
  }

  private async receipts(): Promise<LabState['receipts']> {
    const result = await this.pool.query<{
      message_id: string;
      device_id: string;
      state: string;
      version: string;
    }>(`
      SELECT r.message_id, r.device_id, r.state, r.version
        FROM delivery_receipts r
        JOIN messages m ON m.id = r.message_id
       ORDER BY m.server_sequence NULLS LAST, r.device_id
       LIMIT 60
    `);

    return result.rows.map((row) => ({
      messageId: row.message_id,
      deviceId: row.device_id,
      state: row.state,
      version: Number.parseInt(row.version, 10),
    }));
  }

  private async operations(): Promise<LabState['operations']> {
    const result = await this.pool.query<{
      key: string;
      status: string;
      attempt: number;
      response_status: number | null;
      resource_id: string | null;
    }>(`
      SELECT key, status, attempt, response_status, resource_id
        FROM idempotency_operations
       ORDER BY created_at DESC
       LIMIT 20
    `);

    return result.rows.map((row) => ({
      key: row.key,
      status: row.status,
      attempt: row.attempt,
      responseStatus: row.response_status,
      resourceId: row.resource_id,
    }));
  }

  /**
   * Chequeo de invariantes contra la base.
   *
   * El panel lo muestra permanentemente y tiene que decir cero. Un dashboard que no
   * puede mostrar "cero violaciones" no esta demostrando nada: contar respuestas 2xx
   * no prueba ninguna de estas propiedades.
   */
  private async invariantViolations(): Promise<Array<{ invariant: string; detail: string }>> {
    const violations: Array<{ invariant: string; detail: string }> = [];

    // I4 — dos mensajes en la misma posicion del stream.
    const i4 = await this.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM (
        SELECT 1 FROM messages
         GROUP BY conversation_id, sender_device_id, client_sequence HAVING count(*) > 1
      ) d`);
    if (Number.parseInt(i4.rows[0].count, 10) > 0) {
      violations.push({ invariant: 'I4', detail: `${i4.rows[0].count} posiciones duplicadas` });
    }

    // I5 — dos mensajes publicados en el mismo lugar de la conversacion.
    const i5 = await this.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM (
        SELECT 1 FROM messages WHERE server_sequence IS NOT NULL
         GROUP BY conversation_id, server_sequence HAVING count(*) > 1
      ) d`);
    if (Number.parseInt(i5.rows[0].count, 10) > 0) {
      violations.push({ invariant: 'I5', detail: `${i5.rows[0].count} ordenes duplicados` });
    }

    // I8 — progreso por encima del snapshot.
    const i8 = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_batches WHERE delivered_count > expected_count',
    );
    if (Number.parseInt(i8.rows[0].count, 10) > 0) {
      violations.push({ invariant: 'I8', detail: `${i8.rows[0].count} batches sobrecontados` });
    }

    // I9 — cleanup con dispositivos pendientes.
    const i9 = await findCleanupViolations(this.pool);
    if (i9.length > 0) {
      violations.push({ invariant: 'I9', detail: `${i9.length} cleanups prematuros` });
    }

    return violations;
  }
}
