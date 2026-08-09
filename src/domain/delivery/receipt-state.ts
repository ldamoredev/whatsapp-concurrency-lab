/**
 * Estado de entrega por dispositivo.
 *
 * Es una maquina de estados que solo avanza:
 *
 *     pending ──▶ delivered ──▶ read
 *
 * Nunca al reves. Un ack `delivered` que llega tarde, despues de un `read`, no es un
 * error del cliente: es la red entregando fuera de orden. Se responde como idempotente
 * y el estado no se toca (I7).
 */
export const RECEIPT_STATES = ['pending', 'delivered', 'read'] as const;

export type ReceiptState = (typeof RECEIPT_STATES)[number];

/** Estados que un cliente puede pedir. `pending` es el inicial, nadie lo ackea. */
export type AckState = Extract<ReceiptState, 'delivered' | 'read'>;

/** Posicion en la maquina de estados. Comparar estados es comparar estos numeros. */
export function rankOf(state: ReceiptState): number {
  return RECEIPT_STATES.indexOf(state);
}

/** ¿El estado nuevo avanza respecto del actual? */
export function advances(from: ReceiptState, to: ReceiptState): boolean {
  return rankOf(to) > rankOf(from);
}

/**
 * Estado terminal que habilita el cleanup de envelopes.
 *
 * El alcance lo fija por configuracion y el default es `delivered`: `read` sigue siendo
 * un recibo de producto, no un requisito para liberar trabajo de entrega. Un usuario
 * que nunca abre el chat no puede dejar envelopes colgados para siempre.
 */
export const DEFAULT_TERMINAL_STATE: ReceiptState = 'delivered';

/** ¿Este estado alcanza el umbral que libera el trabajo de entrega? */
export function reachesTerminal(state: ReceiptState, terminal: ReceiptState): boolean {
  return rankOf(state) >= rankOf(terminal);
}
