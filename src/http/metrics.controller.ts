import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { registry } from '../observability/metrics';

@Controller()
export class MetricsController {
  /** Formato de exposicion de Prometheus. Lo scrapea el server, no lo pushea la app. */
  @Get('metrics')
  async metrics(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  }
}
