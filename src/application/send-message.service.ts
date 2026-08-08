import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  ClientSequenceConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyLeaseLostError,
  MessageNotFoundError,
  OperationNotFoundError,
  SenderNotInConversationError,
} from '../domain/idempotency/errors';
import { fingerprintOf } from '../domain/idempotency/fingerprint';
import {
  SEND_MESSAGE_ROUTE,
  type IdempotencyOperation,
  type OperationLease,
} from '../domain/idempotency/idempotency-operation';
import { PG_POOL } from '../infrastructure/database/database.module';
import { createDeliveries, snapshotRecipients } from '../infrastructure/persistence/deliveries.repository';
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
  findMessageById,
  insertPublishedMessage,
  lockNextServerSequence,
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

export interface SendMessageResult {
  /** 201 cuando este request creo el mensaje; 200 cuando devolvio uno ya existente. */
  status: 201 | 200;
  /** true si el resultado sale de una operacion ya completada (replay). */
  replayed: boolean;
  payload: {
    messageId: string;
    conversationId: string;
    clientMessageId: string;
    clientSequence: number;
    serverSequence: number;
    status: string;
  };
}

export interface SendMessageOptions {
  /** Cuanto vale el lease de un owner antes de que otro pueda retomarlo. */
  leaseMs: number;
  /** TTL de la operacion idempotente y del batch de entrega. */
  ttlMs: number;
}

const DEFAULT_OPTIONS: SendMessageOptions = {
  leaseMs: 30_000,
  ttlMs: 24 * 60 * 60 * 1000,
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
   * Envio idempotente.
   *
   * El flujo tiene DOS transacciones y la separacion es deliberada:
   *
   *   Tx1  reclama la key. Corta, commitea sola. Publica "esta operacion tiene dueño"
   *        para que los otros 99 requests concurrentes lo vean y no ejecuten.
   *   Tx2  hace TODO el efecto y lo cierra: lock del contador, mensaje, snapshot de
   *        entrega y la respuesta persistida, en un solo COMMIT.
   *
   * Que Tx2 sea una sola transaccion es lo que elimina las ventanas ambiguas internas:
   * nunca existe un mensaje sin sus deliveries, ni una respuesta guardada sin su
   * mensaje. Ver docs/adr/0001-una-transaccion-para-el-efecto.md.
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
      // Esta es la rama que salva el caso "el commit ocurrio y la respuesta se
      // perdio en la red".
      return {
        kind: 'replay',
        result: {
          status: 200,
          replayed: true,
          payload: operation.responseBody as SendMessageResult['payload'],
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
    const leaseIsAlive = operation.leaseUntil !== null && operation.leaseUntil > new Date();
    if (leaseIsAlive) {
      // El dueño esta vivo y trabajando. El cliente reintenta despues.
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
      // Otro proceso lo retomo primero, entre nuestro SELECT y nuestro UPDATE.
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
   * Una sola transaccion: contador, mensaje, snapshot de entrega y respuesta.
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

  private async publish(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
  ): Promise<SendMessageResult> {
    // 1. Lock del contador de la conversacion. Serializa el orden visible.
    const nextServerSequence = await lockNextServerSequence(client, command.conversationId);
    if (nextServerSequence === null) {
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }

    // 2. El mensaje, ya publicado, ocupando esa posicion.
    const inserted = await insertPublishedMessage(client, {
      clientMessageId: command.clientMessageId,
      conversationId: command.conversationId,
      senderId: command.senderId,
      senderDeviceId: command.senderDeviceId,
      clientSequence: command.clientSequence,
      serverSequence: nextServerSequence,
      body: command.body,
    });

    if (inserted.outcome === 'sender_not_member') {
      throw new SenderNotInConversationError(command.conversationId, command.senderDeviceId);
    }

    if (inserted.outcome === 'stream_position_taken') {
      // I4 se activo: alguien ya ocupa esa posicion del stream. Puede ser un reintento
      // del mismo pedido con una idempotency key NUEVA (el cliente la regenero), en
      // cuyo caso es el mismo mensaje logico y hay que devolverlo. O puede ser otro
      // mensaje, y entonces es un conflicto real.
      return this.adoptExistingMessage(client, command, lease);
    }

    const message = inserted.message;

    // 3. Avanzar el contador. Bajo el mismo lock, en la misma transaccion.
    await advanceServerSequence(client, command.conversationId);

    // 4. Snapshot inmutable de destinatarios + trabajo + recibos.
    const deviceIds = await snapshotRecipients(client, command.conversationId);
    await createDeliveries(client, message.id, deviceIds, this.options.ttlMs);

    const payload = this.payloadOf(message);

    // 5. Cerrar la operacion con la respuesta, verificando el attempt (fencing).
    const completed = await completeOperation(client, {
      operationId: lease.operationId,
      attempt: lease.attempt,
      resourceId: message.id,
      responseStatus: 201,
      responseBody: payload,
    });

    if (!completed) {
      // Perdimos el lease mientras ejecutabamos: otro proceso ya retomo la operacion.
      // El throw dispara el ROLLBACK de executeEffect, asi que el mensaje y las
      // deliveries que acabamos de crear se descartan. Un owner viejo no deja efecto.
      throw new IdempotencyLeaseLostError(command.idempotencyKey, lease.attempt);
    }

    return { status: 201, replayed: false, payload };
  }

  /**
   * La posicion del stream ya esta ocupada. Decide si es el mismo mensaje o un choque.
   *
   * Se lee dentro de la misma transaccion, despues del ROLLBACK TO SAVEPOINT que hizo
   * el repositorio: el lock del contador sigue tomado y la transaccion sigue viva.
   */
  private async adoptExistingMessage(
    client: PoolClient,
    command: SendMessageCommand,
    lease: OperationLease,
  ): Promise<SendMessageResult> {
    const existing = await client.query<{
      id: string;
      client_message_id: string;
      sender_id: string;
      body: string;
      server_sequence: string | null;
      status: string;
    }>(
      `SELECT id, client_message_id, sender_id, body, server_sequence, status
         FROM messages
        WHERE conversation_id = $1 AND sender_device_id = $2 AND client_sequence = $3`,
      [command.conversationId, command.senderDeviceId, command.clientSequence],
    );

    const row = existing.rows[0];

    const isSameLogicalMessage =
      row.client_message_id === command.clientMessageId &&
      row.sender_id === command.senderId &&
      row.body === command.body;

    if (!isSameLogicalMessage) {
      throw new ClientSequenceConflictError(command.clientSequence, row.id);
    }

    // Es el mismo mensaje. NO se crean deliveries: como el efecto entero vive en una
    // transaccion, si el mensaje existe su snapshot tambien existe.
    const payload = {
      messageId: row.id,
      conversationId: command.conversationId,
      clientMessageId: row.client_message_id,
      clientSequence: command.clientSequence,
      serverSequence: Number.parseInt(row.server_sequence ?? '0', 10),
      status: row.status,
    };

    const completed = await completeOperation(client, {
      operationId: lease.operationId,
      attempt: lease.attempt,
      resourceId: row.id,
      responseStatus: 200,
      responseBody: payload,
    });

    if (!completed) {
      throw new IdempotencyLeaseLostError(command.idempotencyKey, lease.attempt);
    }

    return { status: 200, replayed: true, payload };
  }

  private payloadOf(message: StoredMessage): SendMessageResult['payload'] {
    return {
      messageId: message.id,
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      clientSequence: message.clientSequence,
      serverSequence: message.serverSequence ?? 0,
      status: message.status,
    };
  }

  private retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.options.leaseMs / 1000));
  }

  // ---- consultas de recovery ------------------------------------------------

  async getMessage(messageId: string): Promise<StoredMessage> {
    const message = await findMessageById(this.pool, messageId);
    if (message === null) {
      throw new MessageNotFoundError(messageId);
    }
    return message;
  }

  /** Permite al cliente recuperar el resultado de una operacion sin reenviar el efecto. */
  async getOperation(actorId: string, key: string): Promise<IdempotencyOperation> {
    const operation = await findOperation(this.pool, actorId, SEND_MESSAGE_ROUTE, key);
    if (operation === null) {
      throw new OperationNotFoundError(key);
    }
    return operation;
  }
}
