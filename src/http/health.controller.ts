import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { PG_POOL } from '../infrastructure/database/database.module';
import { INSTANCE_ID } from '../observability/instance';
import { lifecycle } from '../observability/lifecycle';

/**
 * Las tres probes, con responsabilidades deliberadamente distintas.
 *
 * El error que evitan: una sola ruta `/health` que chequea todo. Con eso, una base
 * lenta hace fallar liveness, Kubernetes reinicia las tres replicas, y el reinicio no
 * arregla la base — solo agrega una tormenta de arranques encima de un sistema que ya
 * estaba sufriendo.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * startup — ¿termino de arrancar?
   *
   * Es la unica que toca la base, y a proposito: protege un arranque lento. Mientras
   * devuelve 503, Kubernetes no corre liveness ni readiness, asi que un pool que tarda
   * en levantar no provoca un reinicio.
   */
  @Get('startup')
  async startup(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    if (lifecycle.isStarted()) {
      return { status: 'started', instanceId: INSTANCE_ID };
    }

    try {
      await this.pool.query('SELECT 1');
      lifecycle.markStarted();
      return { status: 'started', instanceId: INSTANCE_ID };
    } catch (error) {
      void reply.status(503);
      return {
        status: 'starting',
        instanceId: INSTANCE_ID,
        detail: (error as Error).message,
      };
    }
  }

  /**
   * liveness — ¿el proceso puede progresar?
   *
   * NO consulta la base. Si respondes esto, tu event loop esta girando, que es lo
   * unico que un reinicio puede arreglar. Todo lo demas es responsabilidad de
   * readiness.
   */
  @Get('live')
  live(): unknown {
    return { status: 'alive', instanceId: INSTANCE_ID, uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * readiness — ¿puedo aceptar trabajo ahora?
   *
   * Chequeo local y barato: arranque terminado y no estoy drenando. Deliberadamente
   * NO hace un ping profundo a Postgres: durante una degradacion compartida, las tres
   * replicas se declararian no-ready al mismo tiempo y el servicio se quedaria sin
   * endpoints, convirtiendo una base lenta en una caida total.
   */
  @Get('ready')
  ready(@Res({ passthrough: true }) reply: FastifyReply): unknown {
    if (!lifecycle.isReady()) {
      void reply.status(503);
      return {
        status: lifecycle.isDraining() ? 'draining' : 'starting',
        instanceId: INSTANCE_ID,
      };
    }

    return { status: 'ready', instanceId: INSTANCE_ID };
  }
}
