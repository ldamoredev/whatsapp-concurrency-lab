import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { CleanupDeliveriesService } from '../application/cleanup-deliveries.service';
import { ExpireGapsService } from '../application/expire-gaps.service';
import { LabService, type LabFixture, type LabState } from '../application/lab.service';
import { INSTANCE_ID } from '../observability/instance';

/**
 * Endpoints del panel de laboratorio.
 *
 * SOLO PARA EL LABORATORIO. `POST /lab/reset` trunca todas las tablas. El modulo se
 * registra unicamente cuando `LAB_PANEL_ENABLED` no esta en 'false'; en un despliegue
 * real estaria apagado.
 */
@Controller('lab')
export class LabController {
  constructor(
    @Inject(LabService) private readonly lab: LabService,
    @Inject(ExpireGapsService) private readonly gaps: ExpireGapsService,
    @Inject(CleanupDeliveriesService) private readonly cleanup: CleanupDeliveriesService,
  ) {}

  /** Borra todo y arma una conversacion nueva. Destructivo a proposito. */
  @Post('reset')
  async reset(@Body() rawBody: unknown): Promise<LabFixture & { instanceId: string }> {
    const requested = (rawBody as { deviceCount?: unknown } | null)?.deviceCount;
    const deviceCount =
      typeof requested === 'number' && Number.isInteger(requested) && requested >= 1 && requested <= 8
        ? requested
        : 3;

    const fixture = await this.lab.reset(deviceCount);
    return { ...fixture, instanceId: INSTANCE_ID };
  }

  /** Snapshot del estado, leido de la base. */
  @Get('state')
  async state(): Promise<LabState & { instanceId: string }> {
    const state = await this.lab.state();
    return { ...state, instanceId: INSTANCE_ID };
  }

  /**
   * Corre el barrido de huecos vencidos: el cuerpo del futuro CronJob.
   *
   * `?force=true` adelanta los deadlines al pasado antes de barrer. Es una comodidad
   * del panel para no esperar el `gapTimeoutMs` real haciendo click; NO cambia lo que
   * hace el barrido, solo cuando se lo puede observar.
   */
  @HttpCode(200)
  @Post('expire-gaps')
  async expireGaps(@Query('force') force?: string): Promise<unknown> {
    if (force === 'true') {
      await this.lab.forceGapDeadlines();
    }

    const expired = await this.gaps.run();
    return { instanceId: INSTANCE_ID, expired: expired.length, streams: expired };
  }

  /** Corre el barrido de cleanup de entrega: el otro CronJob. */
  @HttpCode(200)
  @Post('cleanup-deliveries')
  async cleanupDeliveries(): Promise<unknown> {
    const cleaned = await this.cleanup.run();
    return { instanceId: INSTANCE_ID, cleaned: cleaned.length, batches: cleaned };
  }
}
