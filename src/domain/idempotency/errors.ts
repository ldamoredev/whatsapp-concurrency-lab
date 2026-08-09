/**
 * Errores de dominio del envio idempotente.
 *
 * Viven en el dominio y no en la capa HTTP a proposito: el codigo de error es parte
 * del contrato con el cliente, no un detalle de presentacion. La capa HTTP los
 * traduce a status, nada mas.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Misma key, otro fingerprint. El cliente reuso una key para un pedido distinto.
 * No se ejecuta nada: el efecto original queda intacto (I2).
 */
export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(readonly key: string) {
    super(`La idempotency key "${key}" ya fue usada para un pedido con otro contenido.`);
  }
}

/**
 * Misma key, mismo fingerprint, pero la operacion todavia esta en curso en otro lado.
 * El cliente tiene que esperar y reintentar: el resultado va a estar cuando el dueno
 * actual termine.
 */
export class IdempotencyInProgressError extends DomainError {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  constructor(
    readonly key: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`La operacion con key "${key}" esta en curso. Reintentar en ${retryAfterSeconds}s.`);
  }
}

/**
 * El dueno perdio su lease mientras ejecutaba: otro proceso ya tomo la operacion.
 * El efecto se descarta con ROLLBACK. Es el fencing funcionando.
 */
export class IdempotencyLeaseLostError extends DomainError {
  readonly code = 'IDEMPOTENCY_LEASE_LOST';

  constructor(
    readonly key: string,
    readonly attempt: number,
  ) {
    super(
      `El intento ${attempt} de la operacion "${key}" perdio el lease; otro proceso la retomo.`,
    );
  }
}

/** La conversacion no existe, o el dispositivo emisor no es miembro. */
export class SenderNotInConversationError extends DomainError {
  readonly code = 'SENDER_NOT_IN_CONVERSATION';

  constructor(
    readonly conversationId: string,
    readonly senderDeviceId: string,
  ) {
    super(
      `El dispositivo ${senderDeviceId} no participa de la conversacion ${conversationId}, o la conversacion no existe.`,
    );
  }
}

/**
 * Ese (conversacion, dispositivo, client_sequence) ya esta ocupado por OTRO mensaje.
 * No es un reintento: es el mismo lugar del stream pedido con contenido distinto (I4).
 */
export class ClientSequenceConflictError extends DomainError {
  readonly code = 'CLIENT_SEQUENCE_CONFLICT';

  constructor(
    readonly clientSequence: number,
    readonly existingMessageId: string,
  ) {
    super(
      `El client_sequence ${clientSequence} ya fue usado por el mensaje ${existingMessageId} con otro contenido.`,
    );
  }
}

export class MessageNotFoundError extends DomainError {
  readonly code = 'MESSAGE_NOT_FOUND';

  constructor(readonly messageId: string) {
    super(`No existe el mensaje ${messageId}.`);
  }
}

export class OperationNotFoundError extends DomainError {
  readonly code = 'OPERATION_NOT_FOUND';

  constructor(readonly key: string) {
    super(`No existe una operacion con key "${key}" para ese actor.`);
  }
}

/**
 * El stream de ese dispositivo quedo en `resync_required`: hubo un hueco que nunca se
 * completo dentro del deadline.
 *
 * NO se publica salteando el hueco. El cliente tiene que consultar el proximo
 * client_sequence esperado y reenviarlo, o pedir un resync explicito. Esta eleccion
 * preserva el orden y sacrifica disponibilidad para ese dispositivo: es deliberada, y
 * esperar para siempre tampoco seria una solucion.
 */
export class StreamResyncRequiredError extends DomainError {
  readonly code = 'STREAM_RESYNC_REQUIRED';

  constructor(
    readonly conversationId: string,
    readonly deviceId: string,
    readonly nextClientSequence: number,
  ) {
    super(
      `El stream del dispositivo ${deviceId} requiere resync. El proximo client_sequence esperado es ${nextClientSequence}.`,
    );
  }
}

/** Un resync no puede retroceder a posiciones ya publicadas. */
export class InvalidResyncError extends DomainError {
  readonly code = 'INVALID_RESYNC';

  constructor(
    readonly requested: number,
    readonly current: number,
  ) {
    super(
      `No se puede resincronizar en ${requested}: el stream ya va por ${current} y las posiciones anteriores estan publicadas.`,
    );
  }
}

export class StreamNotFoundError extends DomainError {
  readonly code = 'STREAM_NOT_FOUND';

  constructor(
    readonly conversationId: string,
    readonly deviceId: string,
  ) {
    super(`No hay stream registrado para el dispositivo ${deviceId} en ${conversationId}.`);
  }
}

/**
 * El dispositivo no esta en el snapshot de entrega de ese mensaje.
 *
 * "Un dispositivo fuera del snapshot no cambia el batch": no se crea el recibo, no se
 * mueve el conteo. El snapshot se congelo al publicar y es inmutable — si aceptaramos
 * acks de dispositivos agregados despues, `expected_count` dejaria de significar algo
 * y el cleanup no podria decidir nunca.
 */
export class DeviceNotInSnapshotError extends DomainError {
  readonly code = 'DEVICE_NOT_IN_SNAPSHOT';

  constructor(
    readonly messageId: string,
    readonly deviceId: string,
  ) {
    super(
      `El dispositivo ${deviceId} no forma parte del snapshot de entrega del mensaje ${messageId}.`,
    );
  }
}
