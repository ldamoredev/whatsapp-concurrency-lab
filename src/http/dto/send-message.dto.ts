import { BadRequestException } from '@nestjs/common';

/**
 * Validacion de entrada escrita a mano, sin class-validator.
 *
 * Es mas larga que un puñado de decoradores, pero deja ver exactamente que se acepta
 * y que no. En un proyecto cuyo objetivo es poder explicar cada decision, un decorador
 * que valida "por magia" es justamente lo que no queremos.
 */

export interface SendMessageBody {
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  clientSequence: number;
  body: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Limite del cuerpo. Sin esto, la carga de k6 mediria ancho de banda de disco. */
export const MAX_BODY_LENGTH = 4_096;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function fail(errors: string[]): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: errors.join('; '), errors });
}

export function parseUuidParam(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    fail([`${name} debe ser un UUID valido`]);
  }
  return value;
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(['falta el header Idempotency-Key']);
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail([`Idempotency-Key no puede superar ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres`]);
  }
  return value;
}

export function parseSendMessageBody(raw: unknown): SendMessageBody {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(['el body debe ser un objeto JSON']);
  }

  const input = raw as Record<string, unknown>;

  const requireUuid = (field: string): string => {
    const value = input[field];
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      errors.push(`${field} debe ser un UUID valido`);
      return '';
    }
    return value;
  };

  const senderId = requireUuid('senderId');
  const senderDeviceId = requireUuid('senderDeviceId');

  const clientMessageId = input.clientMessageId;
  if (typeof clientMessageId !== 'string' || clientMessageId.trim().length === 0) {
    errors.push('clientMessageId es obligatorio');
  } else if (clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    errors.push(`clientMessageId no puede superar ${MAX_CLIENT_MESSAGE_ID_LENGTH} caracteres`);
  }

  // Se exige un entero real, no un string parseable: `1` y `"1"` producen fingerprints
  // distintos, y aceptar los dos haria que un reintento se viera como conflicto.
  const clientSequence = input.clientSequence;
  if (typeof clientSequence !== 'number' || !Number.isInteger(clientSequence)) {
    errors.push('clientSequence debe ser un entero');
  } else if (clientSequence < 1) {
    errors.push('clientSequence debe ser >= 1');
  } else if (!Number.isSafeInteger(clientSequence)) {
    errors.push('clientSequence excede el rango seguro');
  }

  const body = input.body;
  if (typeof body !== 'string' || body.length === 0) {
    errors.push('body es obligatorio');
  } else if (body.length > MAX_BODY_LENGTH) {
    errors.push(`body no puede superar ${MAX_BODY_LENGTH} caracteres`);
  }

  if (errors.length > 0) {
    fail(errors);
  }

  return {
    senderId,
    senderDeviceId,
    clientMessageId: clientMessageId as string,
    clientSequence: clientSequence as number,
    body: body as string,
  };
}

export interface ResyncBody {
  fromClientSequence: number;
}

export function parseResyncBody(raw: unknown): ResyncBody {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(['el body debe ser un objeto JSON']);
  }

  const value = (raw as Record<string, unknown>).fromClientSequence;

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(['fromClientSequence debe ser un entero']);
  }
  if (value < 1) {
    fail(['fromClientSequence debe ser >= 1']);
  }
  if (!Number.isSafeInteger(value)) {
    fail(['fromClientSequence excede el rango seguro']);
  }

  return { fromClientSequence: value };
}
