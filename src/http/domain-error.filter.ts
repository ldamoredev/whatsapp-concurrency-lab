import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ClientSequenceConflictError,
  DomainError,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyLeaseLostError,
  MessageNotFoundError,
  OperationNotFoundError,
  SenderNotInConversationError,
} from '../domain/idempotency/errors';

/**
 * Traduce errores de dominio a HTTP.
 *
 * La capa HTTP no decide nada: el `code` viene del dominio y acá sólo se le pone un
 * numero. Si mañana el transporte fuera gRPC, el contrato de codigos no cambiaria.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof DomainError) {
      const status = statusFor(exception);

      // El cliente necesita saber cuanto esperar antes de reintentar. Sin esto, un
      // retry inmediato en loop multiplica la carga sobre una operacion que ya esta
      // trabada (el "retry storm" que L3 tiene que descartar).
      if (exception instanceof IdempotencyInProgressError) {
        void reply.header('Retry-After', String(exception.retryAfterSeconds));
      }

      void reply.status(status).send({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      void reply
        .status(exception.getStatus())
        .send(typeof response === 'object' ? response : { message: response });
      return;
    }

    // Un error no previsto no puede filtrar detalles internos al cliente.
    console.error('[unhandled]', exception);
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Error interno.' });
  }
}

function statusFor(error: DomainError): number {
  if (error instanceof IdempotencyKeyReusedError) return 409;
  if (error instanceof IdempotencyInProgressError) return 409;
  if (error instanceof ClientSequenceConflictError) return 409;

  // El owner perdio el lease y su efecto se descarto. Es transitorio: el cliente
  // reintenta y va a encontrar el resultado del owner nuevo.
  if (error instanceof IdempotencyLeaseLostError) return 409;

  // 404 y no 403: no se revela si la conversacion existe o si el dispositivo no es
  // miembro. Son la misma respuesta desde afuera.
  if (error instanceof SenderNotInConversationError) return 404;
  if (error instanceof MessageNotFoundError) return 404;
  if (error instanceof OperationNotFoundError) return 404;

  return 500;
}
