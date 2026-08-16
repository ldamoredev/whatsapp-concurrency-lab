import type { Pool, PoolClient } from 'pg';

/**
 * Auditoria de I1–I10 contra la BASE, para correr despues de una corrida de carga.
 *
 * ALCANCE lo pide con todas las letras: "El test de aplicacion y el test de carga deben
 * consultar la base al final. Contar respuestas 2xx no demuestra ninguna de estas
 * propiedades." Un escenario de caos que solo mire el resumen de k6 esta mirando lo que
 * el cliente CREE que paso, no lo que quedo escrito.
 *
 * QUE SE PUEDE Y QUE NO SE PUEDE AUDITAR DESDE EL ESTADO FINAL, dicho de frente:
 *
 *   I1, I2, I3, I4, I5, I8, I9  se verifican acá, con datos.
 *   I6   es sobre el ORDEN EN QUE SE HIZO VISIBLE un mensaje. El estado final no
 *        guarda ese orden; lo cubre el test de integracion 1,3,4,2.
 *   I7   es sobre TRANSICIONES de un receipt. Un receipt en 'read' no dice si paso por
 *        'pending' o si retrocedio en el medio: haria falta historial. Lo cubre el test
 *        de acks fuera de orden.
 *   I10  el estado final muestra un solo `cleanup_at`, pero no distingue "se limpio una
 *        vez" de "se limpio dos veces y la segunda no cambio nada". Lo cubre la
 *        metrica `lab_delivery_cleanups_total` y el test concurrente.
 *
 * Decirlo importa: un verificador que reportara "I1–I10 OK" cuando en realidad mira
 * siete de diez estaria dando una garantia que no tiene.
 */

type Queryable = Pool | PoolClient;

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

export interface AuditResult {
  violations: InvariantViolation[];
  /** Lo que se conto, para poder mirarlo aunque no haya violaciones. */
  counts: Record<string, number>;
  /** Invariantes que NO se pueden auditar desde el estado final. */
  noAuditables: string[];
}

async function scalar(db: Queryable, sql: string): Promise<number> {
  const result = await db.query<{ value: string }>(sql);
  return Number.parseInt(result.rows[0].value, 10);
}

export async function auditInvariants(db: Queryable): Promise<AuditResult> {
  const violations: InvariantViolation[] = [];

  // I1 — una key compatible produce UN SOLO efecto logico.
  //
  // Se audita al reves de como se escribe: si dos operaciones distintas apuntaran al
  // mismo mensaje, o si un mensaje existiera sin operacion que lo reclame, el "un solo
  // efecto" se habria roto en alguno de los dos sentidos.
  const recursosDuplicados = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT resource_id FROM idempotency_operations
        WHERE resource_id IS NOT NULL
        GROUP BY resource_id HAVING count(*) > 1
     ) d`,
  );
  if (recursosDuplicados > 0) {
    violations.push({
      invariant: 'I1',
      detail: `${recursosDuplicados} mensaje(s) reclamados por mas de una operacion`,
    });
  }

  // I2 — misma key con fingerprint distinto NUNCA ejecuta.
  //
  // La unicidad de (actor, route, key) la garantiza la constraint. Lo que se audita acá
  // es que no exista una key con dos fingerprints, que seria la constraint rota.
  const keysConDosFingerprints = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT actor_id, route, key FROM idempotency_operations
        GROUP BY actor_id, route, key HAVING count(DISTINCT fingerprint) > 1
     ) d`,
  );
  if (keysConDosFingerprints > 0) {
    violations.push({
      invariant: 'I2',
      detail: `${keysConDosFingerprints} key(s) con mas de un fingerprint`,
    });
  }

  // I3 — un retry completado devuelve el MISMO messageId.
  //
  // La respuesta persistida tiene que coincidir con el recurso: si divergieran, dos
  // clientes que reintentan la misma key recibirian ids distintos del mismo envio.
  const respuestasDivergentes = await scalar(
    db,
    `SELECT count(*)::text AS value
       FROM idempotency_operations
      WHERE status = 'completed'
        AND resource_id IS NOT NULL
        AND response_body ->> 'messageId' IS DISTINCT FROM resource_id::text`,
  );
  if (respuestasDivergentes > 0) {
    violations.push({
      invariant: 'I3',
      detail: `${respuestasDivergentes} operacion(es) con response_body != resource_id`,
    });
  }

  // I4 — no hay dos mensajes para el mismo stream y clientSequence.
  const posicionesDuplicadas = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT 1 FROM messages
        GROUP BY conversation_id, sender_device_id, client_sequence HAVING count(*) > 1
     ) d`,
  );
  if (posicionesDuplicadas > 0) {
    violations.push({
      invariant: 'I4',
      detail: `${posicionesDuplicadas} posicion(es) de stream duplicadas`,
    });
  }

  // I5 — serverSequence unica y creciente dentro de la conversacion.
  const ordenesDuplicados = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT 1 FROM messages WHERE server_sequence IS NOT NULL
        GROUP BY conversation_id, server_sequence HAVING count(*) > 1
     ) d`,
  );
  if (ordenesDuplicados > 0) {
    violations.push({
      invariant: 'I5',
      detail: `${ordenesDuplicados} server_sequence duplicados en una conversacion`,
    });
  }

  // I5 (segunda mitad) — el orden no tiene AGUJEROS.
  //
  // Esto es lo que un pod muerto a mitad de transaccion romperia si el contador se
  // incrementara fuera de la transaccion que inserta el mensaje: quedaria un numero
  // entregado a nadie. Como van juntos, un rollback devuelve las dos cosas.
  const conversacionesConAgujero = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT conversation_id
         FROM messages WHERE server_sequence IS NOT NULL
        GROUP BY conversation_id
       HAVING max(server_sequence) <> count(*) OR min(server_sequence) <> 1
     ) d`,
  );
  if (conversacionesConAgujero > 0) {
    violations.push({
      invariant: 'I5',
      detail: `${conversacionesConAgujero} conversacion(es) con agujeros en server_sequence`,
    });
  }

  // I8 — un ack duplicado no incrementa dos veces el progreso.
  const batchesSobrecontados = await scalar(
    db,
    `SELECT count(*)::text AS value
       FROM delivery_batches WHERE delivered_count > expected_count`,
  );
  if (batchesSobrecontados > 0) {
    violations.push({
      invariant: 'I8',
      detail: `${batchesSobrecontados} batch(es) con delivered_count > expected_count`,
    });
  }

  // I9 — no se limpian envelopes con dispositivos esperados pendientes.
  const cleanupsPrematuros = await scalar(
    db,
    `SELECT count(*)::text AS value FROM (
       SELECT b.message_id
         FROM delivery_batches b
         JOIN delivery_receipts r ON r.message_id = b.message_id
        WHERE b.cleanup_reason = 'completed'
        GROUP BY b.message_id, b.expected_count
       HAVING count(*) FILTER (WHERE r.state IN ('delivered', 'read')) < b.expected_count
     ) d`,
  );
  if (cleanupsPrematuros > 0) {
    violations.push({
      invariant: 'I9',
      detail: `${cleanupsPrematuros} batch(es) limpiados con dispositivos pendientes`,
    });
  }

  const counts: Record<string, number> = {
    mensajes: await scalar(db, 'SELECT count(*)::text AS value FROM messages'),
    publicados: await scalar(
      db,
      `SELECT count(*)::text AS value FROM messages WHERE status = 'published'`,
    ),
    bufferizados: await scalar(
      db,
      `SELECT count(*)::text AS value FROM messages WHERE status = 'buffered'`,
    ),
    operaciones: await scalar(db, 'SELECT count(*)::text AS value FROM idempotency_operations'),
    operaciones_completadas: await scalar(
      db,
      `SELECT count(*)::text AS value FROM idempotency_operations WHERE status = 'completed'`,
    ),
    operaciones_en_curso: await scalar(
      db,
      `SELECT count(*)::text AS value FROM idempotency_operations WHERE status = 'in_progress'`,
    ),
    operaciones_falladas: await scalar(
      db,
      `SELECT count(*)::text AS value FROM idempotency_operations WHERE status = 'failed'`,
    ),
  };

  return {
    violations,
    counts,
    noAuditables: [
      'I6 (orden de visibilidad: lo cubre el test 1,3,4,2)',
      'I7 (transiciones de receipt: lo cubre el test de acks fuera de orden)',
      'I10 (cleanup una sola vez: lo cubre la metrica y el test concurrente)',
    ],
  };
}
