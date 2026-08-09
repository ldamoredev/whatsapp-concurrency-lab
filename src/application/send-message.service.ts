import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  ClientSequenceConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyLeaseLostError,
  InvalidResyncError,
  MessageNotFoundError,
  OperationNotFoundError,
  SenderNotInConversationError,
  StreamNotFoundError,
  StreamResyncRequiredError,
} from '../domain/idempotency/errors';
import { fingerprintOf } from '../domain/idempotency/fingerprint';
import {
  SEND_MESSAGE_ROUTE,
  type IdempotencyOperation,
  type OperationLease,
} from '../domain/idempotency/idempotency-operation';
import { PG_POOL } from '../infrastructure/database/database.module';
import {
  createDeliveries,
  snapshotRecipients,
} from '../infrastructure/persistence/deliveries.repository';
import {
  advanceStream,
  findStream,
  lockStream,
  markWaitingGap,
  resyncStream,
  type DeviceStream,
} from '../infrastructure/persistence/device-sequences.repository';
import {
  claimOperation,
  completeOperation,
  failOperation,
  findOperation,
  retryFailedOperation,
  takeOverExpiredLease,
} from '../infrastructure/persistence/idempotency-operations.repository';
import {
  advanceServerSequence,
  findBufferedAt,
  findMessageById,
  hasBufferedMessages,
  insertMessage,
  lockNextServerSequence,
  publishBufferedMessage,
  type StoredMessage,
} from '../infrastructure/persistence/messages.repository';

export interface SendMessageCommand {
  idempotencyKey: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  clientSequence: number;
  body: string;
}

export interface SendMessagePayload {
  messageId: string;
  conversationId: string;
  clientMessageId: string;
  clientSequence: number;
  /** `null` mientras el mensaje esta bufferizado: todavia no tiene lugar visible. */
  serverSequence: number | null;
  status: 'buffered' | 'published';
  /** Estado del stream del emisor despues de procesar este mensaje. */
  stream: {
    state: 'ok' | 'waiting_gap' | 'resync_required';
    nextClientSequence: number;
  };
  /** Cuantos mensajes bufferizados se publicaron en cascada junto con este. */
  drained: number;
}

export interface SendMessageResult {
  /** 201 creado y publicado · 202 aceptado pero bufferizado · 200 replay. */
  status: 201 | 202 | 200;
  replayed: boolean;
  payload: SendMessagePayload;
}

export interface SendMessageOptions {
  /** Cuanto vale el lease de un owner antes de que otro pueda retomarlo. */
  leaseMs: number;
  /** TTL de la operacion idempotente y del batch de entrega. */
  ttlMs: number;
  /** Cuanto se espera un hueco antes de mandar el stream a `resync_required`. */
  gapTimeoutMs: number;
}

const DEFAULT_OPTIONS: SendMessageOptions = {
  leaseMs: 30_000,
  ttlMs: 24 * 60 * 60 * 1000,
  gapTimeoutMs: 30_000,
};

@Injectable()
export class SendMessageService {
  private readonly options: SendMessageOptions;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    options: Partial<SendMessageOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Envio idempotente con orden por stream.
   *
   * El flujo tiene DOS transacciones y la separacion es deliberada:
   *
   *   Tx1  reclama la key. Corta, commitea sola. Publica "esta operacion tiene dueño"
   *        para que los otros 99 requests concurrentes lo vean y no ejecuten.
   *   Tx2  hace TODO el efecto y lo cierra en un solo COMMIT.
   *
   * Ver docs/adr/0001-una-transaccion-para-el-efecto.md.
   */
  async send(command: SendMessageCommand): Promise<SendMessageResult> {
    const fingerprint = fingerprintOf(command);

    // ---- Tx1: reclamar la key ------------------------------------------------
    let lease = await claimOperation(this.pool, {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint,
      leaseMs: this.options.leaseMs,
      ttlMs: this.options.ttlMs,
    });

    if (lease === null) {
      // Perdi la carrera del INSERT. La key ya tiene dueño: hay que averiguar quien
      // es y en que estado quedo. Esto NO es un error todavia.
      const resolved = await this.resolveExistingOperation(command, fingerprint);

      if (resolved.kind === 'replay') {
        return resolved.result;
      }
      lease = resolved.lease;
    }

    // ---- Tx2: el efecto completo --------------------------------------------
    try {
      return await this.executeEffect(command, lease);
    } catch (error) {
      // Liberar el lease para que un retry pueda retomar en vez de esperar a que
      // venza. Si falla el marcado, no importa: el lease vence solo.
      await failOperation(this.pool, lease.operationId, lease.attempt).catch(() => undefined);
      throw error;
    }
  }

  /**
   * La key ya existe. Decide que hacer segun fingerprint, status y lease.
   *
   * Este metodo es todo el contrato de idempotencia leido desde la base, no desde la
   * memoria de este proceso: el dueño puede estar corriendo en otro pod.
   */
  private async resolveExistingOperation(
    command: SendMessageCommand,
    fingerprint: string,
  ): Promise<
    { kind: 'replay'; result: SendMessageResult } | { kind: 'lease'; lease: OperationLease }
  > {
    const operation = await findOperation(
      this.pool,
      command.senderId,
      SEND_MESSAGE_ROUTE,
      command.idempotencyKey,
    );

    if (operation === null) {
      // Carrera fina: existia cuando el INSERT choco y ya no existe (la limpio el
      // barrido de expirados). Reintentar desde cero es correcto.
      return this.claimOrFail(command, fingerprint);
    }

    // I2 — misma key, otro contenido. No se ejecuta nada, y el efecto original queda
    // intacto. Se chequea ANTES que el status: una key reusada es un error del cliente
    // sin importar en que estado este la operacion original.
    if (operation.fingerprint !== fingerprint) {
      throw new IdempotencyKeyReusedError(command.idempotencyKey);
    }

    if (operation.status === 'completed') {
      // I3 — el retry devuelve el resultado ya persistido, sin repetir el efecto.
      return {
        kind: 'replay',
        result: {
          status: 200,
          replayed: true,
          payload: operation.responseBody as SendMessagePayload,
        },
      };
    }

    if (operation.status === 'failed') {
      const retried = await retryFailedOperation(
        this.pool,
        operation.id,
        operation.attempt,
        this.options.leaseMs,
      );
      if (retried === null) {
        throw new IdempotencyInProgressError(command.idempotencyKey, this.retryAfterSeconds());
      }
      return { kind: 'lease', lease: retried };
    }

    // status === 'in_progress'
    //
    // `leaseIsAlive` viene calculado por PostgreSQL, no por `new Date()`. Comparar el
    // `lease_until` que escribio la base contra el reloj de este proceso haria que
    // tres pods con relojes minimamente distintos tomaran decisiones distintas sobre
    // la misma operacion.
    if (operation.leaseIsAlive) {
      throw new IdempotencyInProgressError(command.idempotencyKey, this.retryAfterSeconds());
    }

    // Lease vencido: el dueño murio a mitad de camino. Se retoma con fencing.
    const takenOver = await takeOverExpiredLease(
      this.pool,
      operation.id,
      operation.attempt,
      this.options.leaseMs,
    );

    if (takenOver === null) {
      throw new IdempotencyInProgressError(command.idempotencyKey, this.retryAfterSeconds());
    }

    return { kind: 'lease', lease: takenOver };
  }

  private async claimOrFail(
    command: SendMessageCommand,
    fingerprint: string,
  ): Promise<{ kind: 'lease'; lease: OperationLease }> {
    const lease = await claimOperation(this.pool, {
      actorId: command.senderId,
      route: SEND_MESSAGE_ROUTE,
      key: command.idempotencyKey,
      fingerprint,
      leaseMs: this.options.leaseMs,
      ttlMs: this.options.ttlMs,
    });

    if (lease === null) {
      throw new IdempotencyInProgressError(command.idempotencyKey, this.retryAfterSeconds());
    }
    return { kind: 'lease', lease };
  }

  /**
   * Una sola transaccion: stream, contador, mensaje, entrega y respuesta.
   *
   * Todo commitea junto o no commitea nada. Por eso no hacen falta los recovery points
   * intermedios: no existe un instante observable en el que el mensaje este creado
   * pero las deliveries no.
   */
  private async executeEffect(
    command: SendMessageCommand,
    lease: OperationLease,
  ): Promise<SendMessageResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await this.publish(client, command, lease);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * La decision de orden. Todo esto pasa bajo el lock del stream del emisor.
   *
   * ORDEN DE LOCKS: primero `device_sequences` (el stream), despues
   * `conversation_sequences` (el orden visible), y solo si hay algo que publicar.
   * Siempre en ese orden: invertirlo en algun camino produciria deadlocks entre dos
   * transacciones que publican a la vez en la misma conversacion.
   */
  private async publish(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
  ): Promise<SendMessageResult> {
    const stream = await lockStream(client, command.conversationId, command.senderDeviceId);
    if (stream === null) {
      // No existe la conversacion o el dispositivo. Se responde igual que si el
      // dispositivo no fuera miembro: desde afuera es la misma situacion.
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }
    const expected = stream.nextClientSequence;

    // ── El stream esta roto y espera un resync explicito ──────────────────────
    // Se admite unicamente el mensaje que falta. Cualquier otro se rechaza: publicar
    // aca seria saltear el hueco en silencio, que es exactamente lo que I6 prohibe.
    if (stream.state === 'resync_required' && command.clientSequence !== expected) {
      throw new StreamResyncRequiredError(
        command.conversationId,
        command.senderDeviceId,
        expected,
      );
    }

    // ── Llego uno YA procesado: es un replay a nivel de stream ────────────────
    if (command.clientSequence < expected) {
      return this.adoptExistingMessage(client, command, lease, stream);
    }

    // ── Llego uno adelantado: queda esperando, sin orden visible ──────────────
    if (command.clientSequence > expected) {
      return this.buffer(client, command, lease, stream);
    }

    // ── Es el esperado: se publica y se drena lo que estaba esperando ─────────
    return this.publishAndDrain(client, command, lease);
  }

  /**
   * El mensaje llego adelantado: se guarda `buffered`.
   *
   * NO recibe `server_sequence` y NO genera deliveries. Existe en la base, pero para
   * la conversacion todavia no paso nada: nadie lo va a recibir hasta que llegue el
   * que falta. Eso es I6.
   */
  private async buffer(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
    stream: DeviceStream,
  ): Promise<SendMessageResult> {
    const inserted = await insertMessage(client, {
      clientMessageId: command.clientMessageId,
      conversationId: command.conversationId,
      senderId: command.senderId,
      senderDeviceId: command.senderDeviceId,
      clientSequence: command.clientSequence,
      serverSequence: null,
      body: command.body,
    });

    if (inserted.outcome === 'sender_not_member') {
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }
    if (inserted.outcome === 'stream_position_taken') {
      return this.adoptExistingMessage(client, command, lease, stream);
    }

    // Arranca el reloj del hueco, si no estaba corriendo ya. El deadline se mide desde
    // que aparecio el primer hueco: mandar 5, 6, 7 mientras falta el 2 no lo estira.
    await markWaitingGap(
      client,
      command.conversationId,
      command.senderDeviceId,
      this.options.gapTimeoutMs,
    );

    const payload: SendMessagePayload = {
      messageId: inserted.message.id,
      conversationId: command.conversationId,
      clientMessageId: command.clientMessageId,
      clientSequence: command.clientSequence,
      serverSequence: null,
      status: 'buffered',
      stream: { state: 'waiting_gap', nextClientSequence: stream.nextClientSequence },
      drained: 0,
    };

    this.assertStillOwner(
      await completeOperation(client, {
        operationId: lease.operationId,
        attempt: lease.attempt,
        resourceId: inserted.message.id,
        responseStatus: 202,
        responseBody: payload,
      }),
      command,
      lease,
    );

    return { status: 202, replayed: false, payload };
  }

  /**
   * El mensaje esperado llego: se publica y se drena la cascada.
   *
   * Drenar = publicar, uno por uno y en orden, todos los mensajes contiguos que ya
   * estaban esperando. Con 1, 3, 4 bufferizados y la llegada del 2, salen 2, 3 y 4
   * con `server_sequence` consecutiva, en un solo COMMIT.
   */
  private async publishAndDrain(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
  ): Promise<SendMessageResult> {
    // Segundo lock, y solo ahora: se necesita el orden visible.
    const firstServerSequence = await lockNextServerSequence(client, command.conversationId);
    if (firstServerSequence === null) {
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }

    const inserted = await insertMessage(client, {
      clientMessageId: command.clientMessageId,
      conversationId: command.conversationId,
      senderId: command.senderId,
      senderDeviceId: command.senderDeviceId,
      clientSequence: command.clientSequence,
      serverSequence: firstServerSequence,
      body: command.body,
    });

    if (inserted.outcome === 'sender_not_member') {
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }
    if (inserted.outcome === 'stream_position_taken') {
      const stream = await lockStream(client, command.conversationId, command.senderDeviceId);
      if (stream === null) {
        throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
      }
      return this.adoptExistingMessage(client, command, lease, stream);
    }

    const recipients = await snapshotRecipients(client, command.conversationId);
    await createDeliveries(client, inserted.message.id, recipients, this.options.ttlMs);

    // ── La cascada ────────────────────────────────────────────────────────────
    let nextClientSequence = command.clientSequence + 1;
    let nextServerSequence = firstServerSequence + 1;
    let drained = 0;

    for (;;) {
      const waiting = await findBufferedAt(
        client,
        command.conversationId,
        command.senderDeviceId,
        nextClientSequence,
      );
      if (waiting === null) {
        break;
      }

      const published = await publishBufferedMessage(client, waiting.id, nextServerSequence);
      if (published === null) {
        // Ya lo publico otra transaccion; el update condicional evito pisarlo.
        break;
      }

      // Recien ahora genera trabajo de entrega: mientras estuvo bufferizado, para la
      // conversacion no existia.
      await createDeliveries(client, published.id, recipients, this.options.ttlMs);

      nextClientSequence += 1;
      nextServerSequence += 1;
      drained += 1;
    }

    // Un solo salto del contador de la conversacion, bajo el mismo lock.
    await advanceServerSequence(client, command.conversationId, drained + 1);

    const stillBuffered = await hasBufferedMessages(
      client,
      command.conversationId,
      command.senderDeviceId,
    );

    await advanceStream(
      client,
      command.conversationId,
      command.senderDeviceId,
      nextClientSequence,
      stillBuffered,
      this.options.gapTimeoutMs,
    );

    const payload: SendMessagePayload = {
      messageId: inserted.message.id,
      conversationId: command.conversationId,
      clientMessageId: command.clientMessageId,
      clientSequence: command.clientSequence,
      serverSequence: firstServerSequence,
      status: 'published',
      stream: {
        state: stillBuffered ? 'waiting_gap' : 'ok',
        nextClientSequence,
      },
      drained,
    };

    this.assertStillOwner(
      await completeOperation(client, {
        operationId: lease.operationId,
        attempt: lease.attempt,
        resourceId: inserted.message.id,
        responseStatus: 201,
        responseBody: payload,
      }),
      command,
      lease,
    );

    return { status: 201, replayed: false, payload };
  }

  /**
   * La posicion del stream ya esta ocupada. Decide si es el mismo mensaje o un choque.
   */
  private async adoptExistingMessage(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
    stream: DeviceStream,
  ): Promise<SendMessageResult> {
    const existing = await client.query<{
      id: string;
      client_message_id: string;
      sender_id: string;
      body: string;
      server_sequence: string | null;
      status: 'buffered' | 'published';
    }>(
      `SELECT id, client_message_id, sender_id, body, server_sequence, status
         FROM messages
        WHERE conversation_id = $1 AND sender_device_id = $2 AND client_sequence = $3`,
      [command.conversationId, command.senderDeviceId, command.clientSequence],
    );

    if (existing.rows.length === 0) {
      // El stream avanzo por encima de esta posicion sin que exista el mensaje: solo
      // pasa despues de un resync explicito que salto el hueco. No se puede publicar
      // ahi (dejaria el orden roto) ni inventar un resultado.
      throw new StreamResyncRequiredError(
        command.conversationId,
        command.senderDeviceId,
        stream.nextClientSequence,
      );
    }

    const row = existing.rows[0];

    const isSameLogicalMessage =
      row.client_message_id === command.clientMessageId &&
      row.sender_id === command.senderId &&
      row.body === command.body;

    if (!isSameLogicalMessage) {
      throw new ClientSequenceConflictError(command.clientSequence, row.id);
    }

    const payload: SendMessagePayload = {
      messageId: row.id,
      conversationId: command.conversationId,
      clientMessageId: row.client_message_id,
      clientSequence: command.clientSequence,
      serverSequence:
        row.server_sequence === null ? null : Number.parseInt(row.server_sequence, 10),
      status: row.status,
      stream: { state: stream.state, nextClientSequence: stream.nextClientSequence },
      drained: 0,
    };

    this.assertStillOwner(
      await completeOperation(client, {
        operationId: lease.operationId,
        attempt: lease.attempt,
        resourceId: row.id,
        responseStatus: 200,
        responseBody: payload,
      }),
      command,
      lease,
    );

    return { status: 200, replayed: true, payload };
  }

  /**
   * Si el UPDATE de cierre no toco ninguna fila, este owner perdio el lease.
   * El throw dispara el ROLLBACK de Tx2 y todo lo que se acaba de crear se descarta.
   */
  private assertStillOwner(
    completed: boolean,
    command: SendMessageCommand,
    lease: OperationLease,
  ): void {
    if (!completed) {
      throw new IdempotencyLeaseLostError(command.idempotencyKey, lease.attempt);
    }
  }

  private retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.options.leaseMs / 1000));
  }

  // ---- consultas y contrato de resync ---------------------------------------

  async getMessage(messageId: string): Promise<StoredMessage> {
    const message = await findMessageById(this.pool, messageId);
    if (message === null) {
      throw new MessageNotFoundError(messageId);
    }
    return message;
  }

  async getOperation(actorId: string, key: string): Promise<IdempotencyOperation> {
    const operation = await findOperation(this.pool, actorId, SEND_MESSAGE_ROUTE, key);
    if (operation === null) {
      throw new OperationNotFoundError(key);
    }
    return operation;
  }

  /** El cliente pregunta en que quedo su stream y cual es el proximo esperado. */
  async getStream(conversationId: string, deviceId: string): Promise<DeviceStream> {
    const stream = await findStream(this.pool, conversationId, deviceId);
    if (stream === null) {
      throw new StreamNotFoundError(conversationId, deviceId);
    }
    return stream;
  }

  /**
   * Resync explicito: el cliente declara desde que `client_sequence` sigue.
   *
   * Es el UNICO camino para saltar un hueco, y lo pide el cliente. El servidor nunca
   * decide por su cuenta "ya espere bastante, sigo de largo" — eso seria publicar en
   * silencio un stream con un agujero.
   *
   * Despues de mover el puntero se drena: lo que ya estaba esperando desde esa
   * posicion se publica en orden, en la misma transaccion.
   */
  async resync(
    conversationId: string,
    deviceId: string,
    fromClientSequence: number,
  ): Promise<DeviceStream> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

      const stream = await lockStream(client, conversationId, deviceId);
      if (stream === null) {
        throw new StreamNotFoundError(conversationId, deviceId);
      }

      // No se puede retroceder: esas posiciones ya estan publicadas y I4 las protege.
      if (fromClientSequence < stream.nextClientSequence) {
        throw new InvalidResyncError(fromClientSequence, stream.nextClientSequence);
      }

      await resyncStream(client, conversationId, deviceId, fromClientSequence);
      await this.drainFrom(client, conversationId, deviceId, fromClientSequence);

      const updated = await lockStream(client, conversationId, deviceId);
      await client.query('COMMIT');
      return updated as DeviceStream;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Publica en cascada lo que estaba esperando desde `from`. Usado por el resync. */
  private async drainFrom(
    client: PoolClient,
    conversationId: string,
    deviceId: string,
    from: number,
  ): Promise<number> {
    let nextClientSequence = from;
    let drained = 0;
    let recipients: string[] | null = null;

    for (;;) {
      const waiting = await findBufferedAt(client, conversationId, deviceId, nextClientSequence);
      if (waiting === null) {
        break;
      }

      if (recipients === null) {
        recipients = await snapshotRecipients(client, conversationId);
      }

      const serverSequence = await lockNextServerSequence(client, conversationId);
      if (serverSequence === null) {
        break;
      }

      const published = await publishBufferedMessage(client, waiting.id, serverSequence);
      if (published === null) {
        break;
      }

      await createDeliveries(client, published.id, recipients, this.options.ttlMs);
      await advanceServerSequence(client, conversationId, 1);

      nextClientSequence += 1;
      drained += 1;
    }

    const stillBuffered = await hasBufferedMessages(client, conversationId, deviceId);
    await advanceStream(
      client,
      conversationId,
      deviceId,
      nextClientSequence,
      stillBuffered,
      this.options.gapTimeoutMs,
    );

    return drained;
  }
}
