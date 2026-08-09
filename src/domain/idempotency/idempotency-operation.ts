  /** Ruta idempotente. Forma parte del scope de la key junto con el actor. */
export const SEND_MESSAGE_ROUTE = 'POST /v1/conversations/:conversationId/messages';

export type OperationStatus = 'in_progress' | 'completed' | 'failed';

/**
 * Camino de recuperacion de una operacion.
 *
 * En esta implementacion el efecto entero ocurre en UNA transaccion, asi que la
 * operacion salta de `started` a `completed` sin pasar por los intermedios. Los
 * valores siguen existiendo en el schema porque el camino es parte del contrato del
 * proyecto y porque una implementacion con efectos en varias transacciones los
 * necesitaria. Ver docs/adr/0001-una-transaccion-para-el-efecto.md.
 */
export type RecoveryPoint = 'started' | 'message_persisted' | 'deliveries_created' | 'completed';

export interface IdempotencyOperation {
  id: string;
  actorId: string;
  route: string;
  key: string;
  fingerprint: string;
  status: OperationStatus;
  recoveryPoint: RecoveryPoint;
  attempt: number;
  resourceId: string | null;
  responseStatus: number | null;
  responseBody: unknown;
  leaseUntil: Date | null;
  /**
   * Si el lease sigue vigente, evaluado por el reloj de PostgreSQL.
   *
   * NO se deriva de `leaseUntil` en la aplicacion: con tres pods hay tres relojes y
   * tres respuestas distintas a "ya vencio?". La unica autoridad temporal del sistema
   * es la base.
   */
  leaseIsAlive: boolean;
  expiresAt: Date;
}

/** Owner activo de una operacion: su id y el attempt con el que tiene que cerrarla. */
export interface OperationLease {
  operationId: string;
  attempt: number;
}
