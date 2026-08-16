import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pino, type Logger } from 'pino';
import { INSTANCE_ID } from './instance';

/**
 * Logs estructurados en JSON, correlacionados por request.
 *
 * POR QUE HACEN FALTA SI YA HAY METRICAS. Son preguntas distintas y ninguna reemplaza
 * a la otra:
 *
 *   metrica -> "¿cuantas operaciones terminaron en conflict?"   (agregado, barato)
 *   log     -> "¿que le paso EXACTAMENTE a ESTE envio?"          (individual, caro)
 *
 * Y no es que falte ganas de meterlo en una metrica: NO SE PUEDE. Un `messageId` como
 * label de Prometheus es cardinalidad infinita — una serie temporal nueva por cada
 * mensaje, que tumba al Prometheus antes que al servicio. Por eso los identificadores
 * viven en los logs y los agregados en las metricas, y se cruzan por `requestId`.
 *
 * POR QUE pino. Ya venia en el arbol de dependencias: Fastify lo usa internamente, asi
 * que esto no agrega nada nuevo al `package.json`. Ademas escribe JSON por defecto, que
 * es lo unico que un agregador puede parsear sin reglas fragiles de texto.
 *
 * TODO log lleva `instance` (el pod) y, dentro de un request, `requestId`. Con tres
 * replicas, un log sin instancia obliga a adivinar quien lo escribio.
 */

const nivel = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : nivel,
  base: { service: 'whatsapp-lab-api', instance: INSTANCE_ID },
  // Timestamp ISO y no epoch en milisegundos: lo primero que hace cualquiera con un
  // log es leerlo con los ojos, y `1786838297123` no se lee.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Por defecto pino emite `level: 30`. El numero es mas chico pero obliga a una
    // tabla de traduccion en la cabeza de quien lee y en las queries de Loki.
    level: (label) => ({ level: label }),
  },
});

interface RequestContext {
  requestId: string;
}

/**
 * El `requestId` viaja por AsyncLocalStorage y no como parametro.
 *
 * La alternativa era pasarlo por firma desde el controller hasta el repositorio, lo que
 * significa tocar TODAS las funciones del dominio para agregarles un argumento que no
 * tiene nada que ver con su trabajo. El contexto asincronico lo resuelve sin ensuciar
 * ninguna firma: cualquier funcion, a cualquier profundidad, puede preguntar en que
 * request esta sin haberlo recibido.
 */
const contexto = new AsyncLocalStorage<RequestContext>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return contexto.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return contexto.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Logger con el `requestId` del contexto ya puesto.
 *
 * Se usa en vez de `logger` directo en cualquier lugar que corra dentro de un request:
 * un log sin `requestId` no se puede correlacionar con nada, y en una corrida de carga
 * con 100 ops/s eso es una linea perdida entre miles.
 */
export function log(): Logger {
  const requestId = currentRequestId();
  return requestId === undefined ? logger : logger.child({ requestId });
}
