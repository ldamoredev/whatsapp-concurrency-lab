import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SendMessageService } from '../application/send-message.service';
import { parseIdempotencyKey, parseSendMessageBody, parseUuidParam } from './dto/send-message.dto';

@Controller('v1')
export class MessagesController {
  /**
   * `@Inject` explicito y no inyeccion por tipo.
   *
   * La inyeccion por tipo depende de `emitDecoratorMetadata`, que emite `tsc` pero no
   * esbuild — el transpilador que usa Vitest. Sin el token explicito, la aplicacion
   * funciona compilada y falla en los tests con un `undefined` dificil de leer.
   * Ser explicito hace que el cableado no dependa del compilador.
   */
  constructor(@Inject(SendMessageService) private readonly sendMessage: SendMessageService) {}

  /**
   * Envio idempotente.
   *
   *   201  el mensaje se creo en este request
   *   200  ya existia: replay del resultado persistido (I3)
   *   409  IDEMPOTENCY_KEY_REUSED | IDEMPOTENCY_IN_PROGRESS | CLIENT_SEQUENCE_CONFLICT
   *   404  la conversacion no existe o el dispositivo no participa
   */
  @Post('conversations/:conversationId/messages')
  async send(
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const command = {
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
      conversationId: parseUuidParam(conversationId, 'conversationId'),
      ...parseSendMessageBody(rawBody),
    };

    const result = await this.sendMessage.send(command);

    void reply.status(result.status);
    // Sólo para el laboratorio: permite ver en los tests si la respuesta salio del
    // camino que ejecuto o del que hizo replay.
    void reply.header('X-Idempotent-Replay', String(result.replayed));

    return result.payload;
  }

  /** Consulta de mensaje, para recovery y para verificar invariantes en los tests. */
  @Get('messages/:messageId')
  async getMessage(@Param('messageId') messageId: string): Promise<unknown> {
    const message = await this.sendMessage.getMessage(
      parseUuidParam(messageId, 'messageId'),
    );

    return {
      messageId: message.id,
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      senderId: message.senderId,
      senderDeviceId: message.senderDeviceId,
      clientSequence: message.clientSequence,
      serverSequence: message.serverSequence,
      status: message.status,
      body: message.body,
    };
  }

  /**
   * Consulta de operacion idempotente.
   *
   * Es el camino de recuperacion explicito: un cliente que perdio la respuesta puede
   * preguntar por su key en vez de reenviar el efecto.
   */
  @Get('operations/:key')
  async getOperation(
    @Param('key') key: string,
    @Headers('x-actor-id') actorId: string | undefined,
  ): Promise<unknown> {
    const operation = await this.sendMessage.getOperation(
      parseUuidParam(actorId ?? '', 'X-Actor-Id'),
      key,
    );

    return {
      key: operation.key,
      route: operation.route,
      status: operation.status,
      recoveryPoint: operation.recoveryPoint,
      attempt: operation.attempt,
      resourceId: operation.resourceId,
      responseStatus: operation.responseStatus,
      responseBody: operation.responseBody,
    };
  }
}
