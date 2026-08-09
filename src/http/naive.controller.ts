import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { NaiveService } from '../application/naive.service';
import { INSTANCE_ID } from '../observability/instance';

/**
 * El camino SIN protecciones, para la columna izquierda del panel.
 *
 * SOLO LABORATORIO. Escribe unicamente en las tablas espejo de la migracion 0006, que
 * no tienen constraints. Ningun dato de estos endpoints toca el camino real.
 */
@Controller('lab/naive')
export class NaiveController {
  constructor(@Inject(NaiveService) private readonly naive: NaiveService) {}

  @HttpCode(200)
  @Post('reset')
  async reset(): Promise<unknown> {
    await this.naive.reset();
    return { instanceId: INSTANCE_ID, ok: true };
  }

  /** Envio con SELECT-then-INSERT: la ventana entre las dos consultas. */
  @HttpCode(200)
  @Post('messages')
  async send(@Body() body: Record<string, string | number>): Promise<unknown> {
    const result = await this.naive.send({
      actorId: String(body.actorId),
      route: 'POST /v1/conversations/:conversationId/messages',
      key: String(body.key),
      conversationId: String(body.conversationId),
      senderDeviceId: String(body.senderDeviceId),
      clientSequence: Number(body.clientSequence),
      body: String(body.body ?? 'hola'),
    });

    return { instanceId: INSTANCE_ID, ...result };
  }

  /** Publicacion inmediata: sin buffering, sin politica de huecos. */
  @HttpCode(200)
  @Post('publish')
  async publish(@Body() body: Record<string, string | number>): Promise<unknown> {
    const result = await this.naive.publishImmediately({
      conversationId: String(body.conversationId),
      senderDeviceId: String(body.senderDeviceId),
      clientSequence: Number(body.clientSequence),
      body: String(body.body ?? 'hola'),
    });

    return { instanceId: INSTANCE_ID, ...result };
  }

  /** Ack que suma por evento recibido en vez de por cambio de estado. */
  @HttpCode(200)
  @Post('acks')
  async ack(@Body() body: Record<string, string>): Promise<unknown> {
    const result = await this.naive.ack({
      messageId: String(body.messageId),
      deviceId: String(body.deviceId),
      state: body.state === 'read' ? 'read' : 'delivered',
    });

    return { instanceId: INSTANCE_ID, ...result };
  }

  @Get('state')
  async state(): Promise<unknown> {
    return { instanceId: INSTANCE_ID, ...(await this.naive.state()) };
  }
}
