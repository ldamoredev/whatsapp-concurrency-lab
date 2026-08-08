import { createHash } from 'node:crypto';

/**
 * Fingerprint canonico de una operacion.
 *
 * Es la "foto" de lo que el cliente pidio. Sirve para una sola pregunta: dos requests
 * que traen la misma idempotency key, .pidieron lo mismo o no?
 *
 *   misma key + mismo fingerprint  -> es un reintento -> replay
 *   misma key + otro fingerprint   -> el cliente reuso la key -> 409, sin ejecutar nada
 *
 * Dos propiedades que tiene que cumplir si o si:
 *
 * 1. ESTABLE. El mismo pedido tiene que dar el mismo hash siempre, aunque el JSON
 *    llegue con las claves en otro orden. Si no, un reintento legitimo se veria como
 *    un conflicto y el cliente no podria recuperar nunca su resultado.
 *
 * 2. SIN AMBIGUEDAD. No se pueden concatenar los valores y listo: con `a + b`,
 *    {a:'x', b:'yz'} y {a:'xy', b:'z'} dan la misma cadena "xyz". Dos pedidos
 *    distintos con el mismo fingerprint = un efecto perdido en silencio. Por eso se
 *    serializa con JSON canonico, donde el tipo y los limites de cada campo quedan
 *    marcados.
 */

/**
 * Serializa a JSON con las claves de cada objeto ordenadas, en profundidad.
 *
 * `JSON.stringify` conserva el orden de insercion de las claves, asi que
 * `{a:1, b:2}` y `{b:2, a:1}` producirian cadenas distintas para el mismo pedido.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    // El orden de un array SI es significativo: no se ordena.
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);

  return `{${entries.join(',')}}`;
}

/** Campos que definen el efecto de un envio. La key y la route NO van: son el scope. */
export interface MessageEffect {
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  clientSequence: number;
  body: string;
}

export function fingerprintOf(effect: MessageEffect): string {
  // Se listan los campos explicitamente en vez de hashear el objeto entero: si manana
  // el DTO gana un campo que no cambia el efecto (un timestamp del cliente, un flag de
  // UI), no queremos que dos reintentos identicos empiecen a verse como conflicto.
  return createHash('sha256')
    .update(
      canonicalize({
        conversationId: effect.conversationId,
        senderId: effect.senderId,
        senderDeviceId: effect.senderDeviceId,
        clientMessageId: effect.clientMessageId,
        clientSequence: effect.clientSequence,
        body: effect.body,
      }),
    )
    .digest('hex');
}
