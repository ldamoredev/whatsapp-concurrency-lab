import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { CleanupDeliveriesService } from '../application/cleanup-deliveries.service';
import { ExpireGapsService } from '../application/expire-gaps.service';
import { LabService, type LabFixture, type LabState } from '../application/lab.service';
import { canonicalize, fingerprintOf } from '../domain/idempotency/fingerprint';
import { SEND_MESSAGE_ROUTE } from '../domain/idempotency/idempotency-operation';
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

  /**
   * Calcula el fingerprint de un pedido, con la MISMA funcion que usa el envio real.
   *
   * El panel lo usa para mostrar, antes de mandar nada, que valor va a quedar guardado
   * y como cambia al tocar un campo. Se expone en vez de reimplementarlo en el
   * navegador para que lo que se ve sea el valor de verdad, no una copia que puede
   * divergir.
   */
  @HttpCode(200)
  @Post('fingerprint')
  fingerprint(@Body() body: Record<string, unknown>): unknown {
    const effect = {
      conversationId: String(body.conversationId ?? ''),
      senderId: String(body.senderId ?? ''),
      senderDeviceId: String(body.senderDeviceId ?? ''),
      clientMessageId: String(body.clientMessageId ?? ''),
      clientSequence: Number(body.clientSequence ?? 0),
      body: String(body.body ?? ''),
    };

    return {
      instanceId: INSTANCE_ID,
      route: SEND_MESSAGE_ROUTE,
      // La cadena exacta que se hashea: es lo que hace visible por que dos pedidos
      // con los campos en otro orden dan el mismo fingerprint.
      canonical: canonicalize(effect),
      fingerprint: fingerprintOf(effect),
    };
  }

  /** Corre el barrido de cleanup de entrega: el otro CronJob. */
  @HttpCode(200)
  @Post('cleanup-deliveries')
  async cleanupDeliveries(): Promise<unknown> {
    const cleaned = await this.cleanup.run();
    return { instanceId: INSTANCE_ID, cleaned: cleaned.length, batches: cleaned };
  }
}
