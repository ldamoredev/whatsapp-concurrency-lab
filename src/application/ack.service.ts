import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  DEFAULT_TERMINAL_STATE,
  advances,
  reachesTerminal,
  type AckState,
  type ReceiptState,
} from '../domain/delivery/receipt-state';
import { DeviceNotInSnapshotError, MessageNotFoundError } from '../domain/idempotency/errors';
import { PG_POOL } from '../infrastructure/database/database.module';
import { ackTransitions, deliveryCleanups } from '../observability/metrics';
import {
  advanceReceipt,
  findBatchProgress,
  findReceipt,
  incrementDeliveredCount,
  lockReceipt,
  markEnvelopeDelivered,
  type BatchProgress,
  type StoredReceipt,
} from '../infrastructure/persistence/acks.repository';
import { cleanupBatch } from '../infrastructure/persistence/cleanup.repository';
import { findMessageById } from '../infrastructure/persistence/messages.repository';

export interface AckCommand {
  messageId: string;
  deviceId: string;
  state: AckState;
}

export interface AckResult {
  messageId: string;
  deviceId: string;
  /** Estado del recibo despues del ack. */
  state: ReceiptState;
  /** `false` cuando el ack no movio nada: duplicado o atrasado. */
  advanced: boolean;
  version: number;
  batch: {
    expectedCount: number;
    deliveredCount: number;
    completed: boolean;
    /** `true` si ESTE ack fue el que libero el trabajo de entrega. */
    cleanedUp: boolean;
  };
}

export interface AckOptions {
  /** Estado que libera el trabajo de entrega. Default `delivered`. */
  terminalState: ReceiptState;
  /** Si el ack que completa el batch limpia los envelopes en el acto. */
  cleanupOnComplete: boolean;
}

const DEFAULT_OPTIONS: AckOptions = {
  terminalState: DEFAULT_TERMINAL_STATE,
  cleanupOnComplete: true,
};

@Injectable()
export class AckService {
  private readonly options: AckOptions;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    options: Partial<AckOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Registra un ack de entrega o lectura.
   *
   * Todo ocurre en UNA transaccion: el avance del recibo, el progreso del batch y —si
   * con este ack se completo— la liberacion del trabajo de entrega. No existe un
   * instante en el que el recibo diga `delivered` y el batch todavia no lo cuente.
   *
   * La operacion es idempotente sin necesidad de idempotency key: el estado del recibo
   * ES la clave. Repetir el mismo ack veinte veces lo mueve una sola vez.
   */
  async ack(command: AckCommand): Promise<AckResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

      // 1. Lock del recibo de ESTE dispositivo. Los acks de otros dispositivos sobre
      //    el mismo mensaje no se bloquean: solo se serializan los del mismo device.
      const current = await lockReceipt(client, command.messageId, command.deviceId);

      if (current === null) {
        // El dispositivo no esta en el snapshot. No se crea la fila: el snapshot es
        // inmutable, y un dispositivo que se agrego despues no altera este batch.
        await client.query('ROLLBACK');
        await this.assertMessageExists(command.messageId);
        throw new DeviceNotInSnapshotError(command.messageId, command.deviceId);
      }

      // 2. ¿Avanza? Un ack duplicado o atrasado no es un error: es un no-op.
      if (!advances(current.state, command.state)) {
        // `none` cuenta los duplicados y atrasados. Que sea una serie propia permite
        // ver en el dashboard cuanto trafico de ack es puro reintento.
        ackTransitions.inc({ transition: 'none' });
        const progress = await findBatchProgress(client, command.messageId);
        await client.query('COMMIT');
        return this.resultOf(command, current, progress, false, false);
      }

      // 3. El avance, con la comparacion de estados en el WHERE y compare-and-set
      //    sobre `version`. Si devolviera null, otro lo movio primero.
      const updated = await advanceReceipt(
        client,
        command.messageId,
        command.deviceId,
        command.state,
        current.version,
      );

      if (updated === null) {
        ackTransitions.inc({ transition: 'none' });
        const fresh = await lockReceipt(client, command.messageId, command.deviceId);
        const progress = await findBatchProgress(client, command.messageId);
        await client.query('COMMIT');
        return this.resultOf(command, fresh ?? current, progress, false, false);
      }

      // 4. ¿Cruzo el umbral terminal POR PRIMERA VEZ? Esa es la unica condicion que
      //    incrementa el progreso. Atarlo al cambio real de estado — y no a "llego un
      //    ack" — es lo que hace que 20 acks sumen una vez sola (I8).
      const cruzoElUmbral =
        !reachesTerminal(current.state, this.options.terminalState) &&
        reachesTerminal(updated.state, this.options.terminalState);

      let progress: BatchProgress | null;
      let cleanedUp = false;

      if (cruzoElUmbral) {
        await markEnvelopeDelivered(client, command.messageId, command.deviceId);
        progress = await incrementDeliveredCount(client, command.messageId);

        // 5. Si con este ack se completo, se libera el trabajo de entrega. Compite con
        //    el CronJob por la misma puerta (`cleanup_at IS NULL`); uno solo gana.
        if (progress.completedAt !== null && this.options.cleanupOnComplete) {
          cleanedUp = (await cleanupBatch(client, command.messageId)) !== null;
          if (cleanedUp) {
            deliveryCleanups.inc({ reason: 'completed' });
          }
        }
      } else {
        progress = await findBatchProgress(client, command.messageId);
      }

      ackTransitions.inc({
        transition: updated.state === 'read' ? 'to_read' : 'to_delivered',
      });

      await client.query('COMMIT');
      return this.resultOf(command, updated, progress, true, cleanedUp);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Distingue "el mensaje no existe" de "existe pero vos no estabas en el snapshot". */
  private async assertMessageExists(messageId: string): Promise<void> {
    const message = await findMessageById(this.pool, messageId);
    if (message === null) {
      throw new MessageNotFoundError(messageId);
    }
  }

  private resultOf(
    command: AckCommand,
    receipt: StoredReceipt,
    progress: BatchProgress | null,
    advanced: boolean,
    cleanedUp: boolean,
  ): AckResult {
    return {
      messageId: command.messageId,
      deviceId: command.deviceId,
      state: receipt.state,
      advanced,
      version: receipt.version,
      batch: {
        expectedCount: progress?.expectedCount ?? 0,
        deliveredCount: progress?.deliveredCount ?? 0,
        completed: progress?.completedAt !== null && progress?.completedAt !== undefined,
        cleanedUp,
      },
    };
  }

  /** Lectura del recibo, para tests de invariantes y para el endpoint de consulta. */
  async getReceipt(messageId: string, deviceId: string): Promise<StoredReceipt> {
    const receipt = await findReceipt(this.pool, messageId, deviceId);
    if (receipt === null) {
      throw new DeviceNotInSnapshotError(messageId, deviceId);
    }
    return receipt;
  }
}
