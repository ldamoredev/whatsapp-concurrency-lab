import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Pool } from 'pg';
import { INSTANCE_ID } from './instance';

/**
 * Metricas del laboratorio.
 *
 * REGLA que se respeta en todo el archivo: no se usan `userId`, `messageId`,
 * `conversationId` ni idempotency keys como labels. Cada valor distinto de un label
 * crea una serie temporal nueva; con IDs, Prometheus explota en cardinalidad y se
 * vuelve inutilizable. Esos identificadores van a los logs estructurados, donde el
 * costo es lineal y no cuadratico.
 *
 * `instance` SI es un label, y es el punto: sin el no se puede demostrar que las
 * carreras atravesaron mas de una replica.
 */
export const registry = new Registry();

registry.setDefaultLabels({ instance: INSTANCE_ID });

// CPU, memoria, GC, handles. Lo trae prom-client.
collectDefaultMetrics({ register: registry });

// ---- RED: rate, errors, duration ------------------------------------------

export const httpRequests = new Counter({
  name: 'lab_http_requests_total',
  help: 'Requests HTTP por ruta y status.',
  // `route` es la ruta CON parametros (/v1/messages/:messageId/acks), no la URL
  // concreta. La URL concreta lleva UUIDs y seria cardinalidad infinita.
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'lab_http_request_duration_seconds',
  help: 'Duracion de los requests HTTP.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpInflight = new Gauge({
  name: 'lab_http_inflight_requests',
  help: 'Requests en vuelo en esta replica.',
  registers: [registry],
});

// ---- Resultados de negocio -------------------------------------------------

/**
 * Como termino cada operacion idempotente.
 *
 * `outcome` es un enum chico y cerrado: owner, replay, conflict, in_progress,
 * lease_lost. Es exactamente la metrica que el alcance pide y la que contesta
 * "¿cuantos de los 100 requests concurrentes fueron replay?".
 */
export const idempotencyOutcomes = new Counter({
  name: 'lab_idempotency_outcomes_total',
  help: 'Resultado de las operaciones idempotentes.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const messagesPublished = new Counter({
  name: 'lab_messages_published_total',
  help: 'Mensajes que recibieron orden visible, incluidos los drenados en cascada.',
  labelNames: ['origin'] as const, // direct | drained
  registers: [registry],
});

export const messagesBuffered = new Counter({
  name: 'lab_messages_buffered_total',
  help: 'Mensajes que llegaron adelantados y quedaron esperando un hueco.',
  registers: [registry],
});

export const streamResyncRequired = new Counter({
  name: 'lab_stream_resync_required_total',
  help: 'Streams que pasaron a resync_required por un hueco vencido.',
  registers: [registry],
});

export const ackTransitions = new Counter({
  name: 'lab_ack_transitions_total',
  help: 'Acks por transicion efectiva. `none` son los duplicados o atrasados.',
  labelNames: ['transition'] as const, // to_delivered | to_read | none
  registers: [registry],
});

export const deliveryCleanups = new Counter({
  name: 'lab_delivery_cleanups_total',
  help: 'Batches cuyo trabajo de entrega se libero, por razon.',
  labelNames: ['reason'] as const, // completed | expired
  registers: [registry],
});

/**
 * Violaciones de invariantes detectadas. Tiene que quedarse en cero.
 *
 * Que exista la metrica es parte del punto: un dashboard que no puede mostrar "cero
 * violaciones" no esta demostrando nada.
 */
export const invariantViolations = new Counter({
  name: 'lab_invariant_violations_total',
  help: 'Violaciones de invariantes detectadas. Siempre cero.',
  labelNames: ['invariant'] as const,
  registers: [registry],
});

// ---- Saturacion ------------------------------------------------------------

/**
 * Event loop lag.
 *
 * Es LA metrica de saturacion de un proceso Node: si el event loop no progresa, el
 * proceso esta vivo pero no puede atender. Un liveness que solo hace ping al puerto
 * no lo detecta.
 */
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 10 });
eventLoopHistogram.enable();

new Gauge({
  name: 'lab_event_loop_lag_seconds',
  help: 'Retraso del event loop (p50, p99 y maximo desde el ultimo scrape).',
  labelNames: ['quantile'] as const,
  registers: [registry],
  collect(): void {
    this.set({ quantile: 'p50' }, eventLoopHistogram.percentile(50) / 1e9);
    this.set({ quantile: 'p99' }, eventLoopHistogram.percentile(99) / 1e9);
    this.set({ quantile: 'max' }, eventLoopHistogram.max / 1e9);
    eventLoopHistogram.reset();
  },
});

/**
 * Estado del pool de Postgres.
 *
 * `waiting` es la que importa bajo carga: si crece, la base es el cuello de botella y
 * la API esta encolando en vez de rechazar. L3 tiene que mostrar esto acotado.
 */
export function registerPoolMetrics(pool: Pool): void {
  new Gauge({
    name: 'lab_pg_pool_connections',
    help: 'Conexiones del pool de PostgreSQL por estado.',
    labelNames: ['state'] as const,
    registers: [registry],
    collect(): void {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
      this.set({ state: 'active' }, pool.totalCount - pool.idleCount);
    },
  });
}

export const readiness = new Gauge({
  name: 'lab_ready',
  help: '1 si la replica acepta trabajo, 0 si esta drenando.',
  registers: [registry],
});
readiness.set(1);
