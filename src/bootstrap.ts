import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule, LAB_PANEL_ENABLED } from './app.module';
import { DomainErrorFilter } from './http/domain-error.filter';
import { PG_POOL } from './infrastructure/database/database.module';
import { INSTANCE_ID } from './observability/instance';
import { lifecycle } from './observability/lifecycle';
import {
  httpDuration,
  httpInflight,
  httpRequests,
  registerPoolMetrics,
} from './observability/metrics';

/**
 * Construccion de la aplicacion, compartida por el server, las demos y los tests e2e.
 *
 * Tenerla en un solo lugar importa: si cada entrada armara la app a su manera, los
 * tests e2e estarian probando una aplicacion que no es la que corre en produccion.
 */
export async function createApp(options: { logger?: boolean } = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: options.logger === false ? false : undefined,
  });

  app.useGlobalFilters(new DomainErrorFilter());

  // CORS abierto SOLO cuando el panel esta habilitado.
  //
  // El panel se sirve desde una replica y manda requests a las otras dos, que estan en
  // puertos distintos: sin CORS el navegador bloquea justamente la parte que se quiere
  // demostrar. Con Traefik las tres van a estar detras del mismo origen y esto deja de
  // hacer falta.
  if (LAB_PANEL_ENABLED) {
    app.enableCors({ origin: true, exposedHeaders: ['X-Instance-Id', 'X-Idempotent-Replay'] });
  }
  registerHttpInstrumentation(app);
  registerPoolMetrics(app.get<Pool>(PG_POOL));

  // NO se llama a `app.enableShutdownHooks()`.
  //
  // Ese metodo hace que Nest enganche SIGTERM por su cuenta y cierre la aplicacion de
  // inmediato — en paralelo con el drenaje de `installShutdownHandlers`, que necesita
  // unos segundos antes de cerrar. Las dos cerraban a la vez y el pool terminaba
  // cerrandose dos veces.
  //
  // `app.close()` dispara igual los hooks de ciclo de vida de todos los modulos, asi
  // que no se pierde nada: solo se recupera el control del ORDEN.
  return app;
}

interface TimedRequest {
  labStart?: bigint;
}

/**
 * Instrumentacion HTTP con hooks de Fastify.
 *
 * Se usan hooks y no un interceptor de Nest por una razon concreta: en `onResponse`,
 * Fastify ya resolvio que ruta matcheo y expone el patron CON parametros
 * (`/v1/messages/:messageId/acks`). Un interceptor solo ve la URL concreta, que lleva
 * UUIDs — y usar eso como label de Prometheus seria cardinalidad infinita.
 */
function registerHttpInstrumentation(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request, reply, done) => {
    (request as TimedRequest).labStart = process.hrtime.bigint();
    httpInflight.inc();

    // Solo para el laboratorio: es la evidencia de que el balanceador repartio las
    // carreras. Un sistema real no le cuenta al cliente que pod lo atendio.
    void reply.header('X-Instance-Id', INSTANCE_ID);
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    httpInflight.dec();

    const start = (request as TimedRequest).labStart;
    // `routeOptions.url` es el patron con :params. La URL concreta seria un label
    // distinto por cada UUID.
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };

    httpRequests.inc(labels);
    if (start !== undefined) {
      httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    }

    done();
  });
}

/**
 * Apagado ordenado.
 *
 * El orden importa y cada paso tiene un motivo:
 *
 *  1. readiness pasa a 503. El balanceador saca a esta replica de rotacion.
 *  2. Se espera `drainDelayMs`. Kubernetes actualiza endpoints de forma asincronica:
 *     durante ese rato el kube-proxy todavia puede mandar requests. Cerrar aca seria
 *     devolver errores por trafico que ya estaba en camino.
 *  3. `app.close()` deja de aceptar conexiones, espera las inflight y dispara los
 *     shutdown hooks de Nest, que cierran el pool.
 *
 * Todo tiene que entrar en el `terminationGracePeriodSeconds` del Deployment, o
 * Kubernetes manda SIGKILL y las transacciones en vuelo se cortan.
 */
export function installShutdownHandlers(
  app: NestFastifyApplication,
  drainDelayMs = 5_000,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`[${INSTANCE_ID}] ${signal} recibido: marcando no-ready y drenando.`);
    lifecycle.startDraining();

    await new Promise((resolve) => setTimeout(resolve, drainDelayMs));

    console.log(`[${INSTANCE_ID}] cerrando conexiones y pool.`);
    await app.close();
    console.log(`[${INSTANCE_ID}] apagado limpio.`);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
