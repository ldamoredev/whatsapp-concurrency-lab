import { randomUUID } from 'node:crypto';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import type {
  IdempotencyOperation,
  OperationLease,
  OperationStatus,
  RecoveryPoint,
} from '../../domain/idempotency/idempotency-operation';

type Queryable = Pool | PoolClient;

export const UNIQUE_VIOLATION = '23505';
export const OPERATION_KEY_CONSTRAINT = 'idempotency_operations_actor_route_key_uniq';

interface OperationRow {
  id: string;
  actor_id: string;
  route: string;
  key: string;
  fingerprint: string;
  status: OperationStatus;
  recovery_point: RecoveryPoint;
  attempt: number;
  resource_id: string | null;
  response_status: number | null;
  response_body: unknown;
  lease_until: Date | null;
  expires_at: Date;
}

function toOperation(row: OperationRow): IdempotencyOperation {
  return {
    id: row.id,
    actorId: row.actor_id,
    route: row.route,
    key: row.key,
    fingerprint: row.fingerprint,
    status: row.status,
    recoveryPoint: row.recovery_point,
    attempt: row.attempt,
    resourceId: row.resource_id,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    leaseUntil: row.lease_until,
    expiresAt: row.expires_at,
  };
}

const SELECT_COLUMNS = `
  id, actor_id, route, key, fingerprint, status, recovery_point,
  attempt, resource_id, response_status, response_body, lease_until, expires_at
`;

export interface ClaimInput {
  actorId: string;
  route: string;
  key: string;
  fingerprint: string;
  leaseMs: number;
  ttlMs: number;
}

/**
 * Intenta reclamar la key: soy el primero o no soy nadie.
 *
 * Devuelve el lease si el INSERT gano, o `null` si la key ya tiene dueno. `null` NO
 * es un error: es la respuesta normal para 99 de 100 requests concurrentes, y quiere
 * decir "anda a leer lo que hizo el dueno".
 *
 * Toda la decision es el INSERT. No hay un SELECT previo que pregunte "existe?",
 * porque entre ese SELECT y el INSERT hay una ventana en la que otro pod inserta.
 */
export async function claimOperation(
  db: Queryable,
  input: ClaimInput,
): Promise<OperationLease | null> {
  const id = randomUUID();

  try {
    await db.query(
      `INSERT INTO idempotency_operations (
         id, actor_id, route, key, fingerprint,
         status, recovery_point, attempt, lease_until, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         'in_progress', 'started', 1,
         now() + make_interval(secs => $6::double precision),
         now() + make_interval(secs => $7::double precision)
       )`,
      [id, input.actorId, input.route, input.key, input.fingerprint, input.leaseMs / 1000, input.ttlMs / 1000],
    );

    return { operationId: id, attempt: 1 };
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === UNIQUE_VIOLATION &&
      error.constraint === OPERATION_KEY_CONSTRAINT
    ) {
      return null;
    }
    throw error;
  }
}

export async function findOperation(
  db: Queryable,
  actorId: string,
  route: string,
  key: string,
): Promise<IdempotencyOperation | null> {
  const result = await db.query<OperationRow>(
    `SELECT ${SELECT_COLUMNS} FROM idempotency_operations
      WHERE actor_id = $1 AND route = $2 AND key = $3`,
    [actorId, route, key],
  );

  return result.rows.length > 0 ? toOperation(result.rows[0]) : null;
}

/**
 * Retoma una operacion abandonada cuyo lease vencio.
 *
 * El `WHERE attempt = $2` es el corazon del fencing: si otro proceso ya la retomo,
 * el attempt subio y este UPDATE toca 0 filas. Dos procesos no pueden creerse dueños
 * del mismo intento.
 *
 * `lease_until < now()` se evalua en el reloj de PostgreSQL, no en el de la API: con
 * tres pods, tres relojes distintos decidirian cosas distintas.
 */
export async function takeOverExpiredLease(
  db: Queryable,
  operationId: string,
  expectedAttempt: number,
  leaseMs: number,
): Promise<OperationLease | null> {
  const result = await db.query(
    `UPDATE idempotency_operations
        SET attempt      = attempt + 1,
            lease_until  = now() + make_interval(secs => $3::double precision),
            updated_at   = now()
      WHERE id = $1
        AND attempt = $2
        AND status = 'in_progress'
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING attempt`,
    [operationId, expectedAttempt, leaseMs / 1000],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return { operationId, attempt: (result.rows[0] as { attempt: number }).attempt };
}

export interface CompleteInput {
  operationId: string;
  attempt: number;
  resourceId: string;
  responseStatus: number;
  responseBody: unknown;
}

/**
 * Cierra la operacion guardando la respuesta reproducible.
 *
 * Devuelve `false` si el UPDATE no toco ninguna fila, es decir: este owner perdio el
 * lease y otro ya retomo la operacion. Quien llama TIENE que hacer ROLLBACK — el
 * efecto de un owner viejo no puede quedar.
 *
 * Marcar completed y persistir la respuesta son la misma sentencia. La constraint
 * `idempotency_operations_completed_has_response` lo exige, asi que ni siquiera un
 * bug futuro puede separarlos.
 */
export async function completeOperation(db: Queryable, input: CompleteInput): Promise<boolean> {
  const result = await db.query(
    `UPDATE idempotency_operations
        SET status          = 'completed',
            recovery_point  = 'completed',
            resource_id     = $3,
            response_status = $4,
            response_body   = $5::jsonb,
            lease_until     = NULL,
            updated_at      = now()
      WHERE id = $1
        AND attempt = $2
        AND status = 'in_progress'`,
    [
      input.operationId,
      input.attempt,
      input.resourceId,
      input.responseStatus,
      JSON.stringify(input.responseBody),
    ],
  );

  return result.rowCount === 1;
}

/** Marca la operacion como fallida liberando el lease, para que un retry pueda retomarla. */
export async function failOperation(
  db: Queryable,
  operationId: string,
  attempt: number,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_operations
        SET status = 'failed', lease_until = NULL, updated_at = now()
      WHERE id = $1 AND attempt = $2 AND status = 'in_progress'`,
    [operationId, attempt],
  );
}

/** Vuelve a poner en curso una operacion `failed`, tomando el lease con fencing. */
export async function retryFailedOperation(
  db: Queryable,
  operationId: string,
  expectedAttempt: number,
  leaseMs: number,
): Promise<OperationLease | null> {
  const result = await db.query(
    `UPDATE idempotency_operations
        SET status       = 'in_progress',
            attempt      = attempt + 1,
            lease_until  = now() + make_interval(secs => $3::double precision),
            updated_at   = now()
      WHERE id = $1 AND attempt = $2 AND status = 'failed'
      RETURNING attempt`,
    [operationId, expectedAttempt, leaseMs / 1000],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return { operationId, attempt: (result.rows[0] as { attempt: number }).attempt };
}
