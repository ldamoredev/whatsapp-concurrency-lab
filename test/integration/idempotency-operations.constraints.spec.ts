import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PG_ERROR,
  closeTestPool,
  countRows,
  expectViolation,
  testPool,
  truncateAll,
} from './helpers/database';
import { insertIdempotencyOperation, uuid } from './helpers/fixtures';

/**
 * I1 — una idempotency key compatible produce un solo efecto logico.
 *
 * La constraint que lo garantiza es UNIQUE (actor_id, route, key). Estos tests la
 * prueban rompiendola: un test que solo inserta una operacion feliz pasaria igual
 * con la constraint borrada.
 */
describe('idempotency_operations — I1', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('RECHAZA una segunda operacion con el mismo (actor_id, route, key)', async () => {
    const actorId = uuid();
    const route = 'POST /v1/conversations/:conversationId/messages';
    const key = 'idem-key-1';

    await insertIdempotencyOperation({ actorId, route, key });

    await expectViolation(() => insertIdempotencyOperation({ actorId, route, key }), {
      code: PG_ERROR.UNIQUE_VIOLATION,
      constraint: 'idempotency_operations_actor_route_key_uniq',
    });

    expect(await countRows('idempotency_operations')).toBe(1);
  });

  it('RECHAZA el duplicado incluso con otro fingerprint (I2: la key ya tiene dueno)', async () => {
    const actorId = uuid();
    const route = 'POST /v1/conversations/:conversationId/messages';
    const key = 'idem-key-2';

    await insertIdempotencyOperation({ actorId, route, key, fingerprint: 'fp-original' });

    // La misma key con otro cuerpo NO puede crear una segunda operacion: tiene que
    // chocar contra la existente para que la aplicacion pueda comparar fingerprints
    // y responder 409 IDEMPOTENCY_KEY_REUSED sin ejecutar nada.
    await expectViolation(
      () => insertIdempotencyOperation({ actorId, route, key, fingerprint: 'fp-distinto' }),
      {
        code: PG_ERROR.UNIQUE_VIOLATION,
        constraint: 'idempotency_operations_actor_route_key_uniq',
      },
    );

    const stored = await testPool().query<{ fingerprint: string }>(
      'SELECT fingerprint FROM idempotency_operations WHERE key = $1',
      [key],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].fingerprint).toBe('fp-original');
  });

  it('la key esta scopeada: la misma key de OTRO actor o en OTRA ruta es otra operacion', async () => {
    const key = 'idem-key-compartida';
    const route = 'POST /v1/conversations/:conversationId/messages';
    const actorId = uuid();

    await insertIdempotencyOperation({ actorId, route, key });
    await insertIdempotencyOperation({ actorId: uuid(), route, key });
    await insertIdempotencyOperation({ actorId, route: 'POST /v1/messages/:messageId/acks', key });

    expect(await countRows('idempotency_operations')).toBe(3);
  });

  it('CARRERA: 40 inserts concurrentes con la misma key dejan exactamente una operacion', async () => {
    const actorId = uuid();
    const route = 'POST /v1/conversations/:conversationId/messages';
    const key = 'idem-key-carrera';
    const attempts = 40;

    // Esta es la forma real de C1: N requests con la misma key llegando a la vez a
    // replicas distintas. En READ COMMITTED ninguna ve la fila no commiteada de la
    // otra, asi que las 40 creen ser la primera. Solo la constraint decide.
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        insertIdempotencyOperation({ actorId, route, key, fingerprint: 'fp-igual' }),
      ),
    );

    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(attempts - 1);

    // Los perdedores no fallan de cualquier manera: fallan con 23505 sobre la
    // constraint de I1, que es la senal que la aplicacion traduce a replay o a
    // IDEMPOTENCY_IN_PROGRESS.
    for (const loser of losers) {
      const error = (loser as PromiseRejectedResult).reason;
      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION);
      expect(error.constraint).toBe('idempotency_operations_actor_route_key_uniq');
    }

    expect(await countRows('idempotency_operations')).toBe(1);
  });
});

describe('idempotency_operations — coherencia de la maquina de estados', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('RECHAZA marcar completed sin respuesta persistida (haria imposible I3)', async () => {
    await expectViolation(
      () =>
        insertIdempotencyOperation({
          status: 'completed',
          recoveryPoint: 'completed',
          responseStatus: null,
          responseBody: undefined,
        }),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'idempotency_operations_completed_has_response',
      },
    );

    expect(await countRows('idempotency_operations')).toBe(0);
  });

  it('ACEPTA completed cuando la respuesta reproducible esta guardada', async () => {
    const resourceId = uuid();

    await insertIdempotencyOperation({
      status: 'completed',
      recoveryPoint: 'completed',
      resourceId,
      responseStatus: 201,
      responseBody: { messageId: resourceId },
    });

    const stored = await testPool().query<{ response_body: { messageId: string } }>(
      'SELECT response_body FROM idempotency_operations WHERE resource_id = $1',
      [resourceId],
    );
    expect(stored.rows[0].response_body.messageId).toBe(resourceId);
  });

  it('RECHAZA el recovery point terminal en una operacion que no esta completed', async () => {
    await expectViolation(
      () => insertIdempotencyOperation({ status: 'in_progress', recoveryPoint: 'completed' }),
      {
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'idempotency_operations_recovery_point_matches_status',
      },
    );
  });

  it('RECHAZA un status fuera de la maquina de estados', async () => {
    await expectViolation(
      () => insertIdempotencyOperation({ status: 'casi_listo' as never }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'idempotency_operations_status_valid' },
    );
  });

  it('RECHAZA un recovery point inventado', async () => {
    await expectViolation(
      () => insertIdempotencyOperation({ recoveryPoint: 'casi_persistido' as never }),
      { code: PG_ERROR.CHECK_VIOLATION, constraint: 'idempotency_operations_recovery_point_valid' },
    );
  });

  it('RECHAZA attempt 0: el fencing token empieza en 1', async () => {
    await expectViolation(() => insertIdempotencyOperation({ attempt: 0 }), {
      code: PG_ERROR.CHECK_VIOLATION,
      constraint: 'idempotency_operations_attempt_positive',
    });
  });
});
