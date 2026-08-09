import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { AckService } from '../application/ack.service';
import { parseAckBody, parseUuidParam } from './dto/send-message.dto';

@Controller('v1/messages/:messageId')
export class AcksController {
  constructor(@Inject(AckService) private readonly acks: AckService) {}

  /**
   * Ack de entrega o lectura.
   *
   * No lleva Idempotency-Key y no la necesita: el estado del recibo ES la clave. El
   * mismo ack repetido veinte veces mueve el recibo una sola vez, porque la condicion
   * de avance vive en el WHERE del UPDATE.
   *
   *   200  siempre que el dispositivo este en el snapshot, avance o no
   *   404  el mensaje no existe, o el dispositivo no estaba en el snapshot
   */
  // 200 y no el 201 que Nest pone por default en POST: un ack no crea un recurso,
  // mueve el estado de uno que ya existe. Y muchas veces no mueve nada.
  @HttpCode(200)
  @Post('acks')
  async ack(
    @Param('messageId') messageId: string,
    @Body() rawBody: unknown,
  ): Promise<unknown> {
    const { deviceId, state } = parseAckBody(rawBody);

    const result = await this.acks.ack({
      messageId: parseUuidParam(messageId, 'messageId'),
      deviceId,
      state,
    });

    return result;
  }

  /** Estado durable de entrega para un dispositivo. Sobrevive al cleanup. */
  @Get('receipts/:deviceId')
  async receipt(
    @Param('messageId') messageId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<unknown> {
    const receipt = await this.acks.getReceipt(
      parseUuidParam(messageId, 'messageId'),
      parseUuidParam(deviceId, 'deviceId'),
    );

    return {
      messageId: receipt.messageId,
      deviceId: receipt.deviceId,
      state: receipt.state,
      deliveredAt: receipt.deliveredAt,
      readAt: receipt.readAt,
      version: receipt.version,
    };
  }
}
