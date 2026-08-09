import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { SendMessageService } from '../application/send-message.service';
import { parseResyncBody, parseUuidParam } from './dto/send-message.dto';

/**
 * Contrato explicito de resincronizacion.
 *
 * Cuando un hueco vence, el stream de ese dispositivo queda en `resync_required` y
 * deja de aceptar mensajes. El servidor NO salta el hueco por su cuenta: el cliente
 * tiene que preguntar en que quedo y decidir. Estos dos endpoints son esa
 * conversacion.
 */
@Controller('v1/conversations/:conversationId/devices/:deviceId/stream')
export class StreamsController {
  constructor(@Inject(SendMessageService) private readonly messages: SendMessageService) {}

  /** En que quedo mi stream y cual es el proximo client_sequence que esperan de mi. */
  @Get()
  async get(
    @Param('conversationId') conversationId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<unknown> {
    const stream = await this.messages.getStream(
      parseUuidParam(conversationId, 'conversationId'),
      parseUuidParam(deviceId, 'deviceId'),
    );

    return {
      conversationId: stream.conversationId,
      deviceId: stream.deviceId,
      nextClientSequence: stream.nextClientSequence,
      state: stream.state,
      gapDeadline: stream.gapDeadline,
    };
  }

  /**
   * El cliente declara desde que client_sequence sigue.
   *
   * Es la unica forma de saltar un hueco, y la decision es del cliente: el que sabe si
   * aquel mensaje 2 se perdio para siempre o todavia puede reenviarlo es el, no el
   * servidor. Lo que ya estaba bufferizado desde esa posicion se publica en orden.
   */
  @Post('resync')
  async resync(
    @Param('conversationId') conversationId: string,
    @Param('deviceId') deviceId: string,
    @Body() rawBody: unknown,
  ): Promise<unknown> {
    const { fromClientSequence } = parseResyncBody(rawBody);

    const stream = await this.messages.resync(
      parseUuidParam(conversationId, 'conversationId'),
      parseUuidParam(deviceId, 'deviceId'),
      fromClientSequence,
    );

    return {
      conversationId: stream.conversationId,
      deviceId: stream.deviceId,
      nextClientSequence: stream.nextClientSequence,
      state: stream.state,
      gapDeadline: stream.gapDeadline,
    };
  }
}
