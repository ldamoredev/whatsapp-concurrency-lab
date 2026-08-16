/**
 * L1 — carga sostenida con la mezcla real de operaciones.
 *
 *   npm run k6:l1
 *
 * El escenario base manda un solo tipo de request: sirve como referencia limpia, no
 * como carga realista. Este es el que pide ALCANCE para L1 — envios unicos, retries
 * equivalentes, conflictos deliberados y acks, mezclados sobre un dataset con varias
 * conversaciones y al menos una caliente.
 *
 * POR QUE LA MEZCLA IMPORTA. Las cuatro operaciones tocan caminos distintos y sus
 * costos no se parecen en nada:
 *
 *   envio unico   transaccion completa, con el lock del contador de la conversacion
 *   retry         un SELECT: encuentra la respuesta guardada y la repite
 *   conflicto     un SELECT y un rechazo; no llega a ejecutar el efecto
 *   ack           UPDATE condicional sobre el recibo, sin tocar el contador
 *
 * Una corrida de puros envios exagera el costo; una de puros retries lo esconde. Por
 * eso ademas de `http_req_duration` hay un Trend por operacion: un p95 agregado sobre
 * cuatro costos distintos no dice cual se degrado.
 *
 * COMO SE FABRICA EL CALOR, que es la parte que casi sale mal. El calor NO se hace
 * mandando mas trafico a la misma conversacion: el orden se asigna por
 * (conversacion, dispositivo), asi que dos VUs sobre el MISMO stream se pisan el
 * `client_sequence` y generan conflictos que no tienen nada que ver con la carga.
 *
 * El calor real es estructural: la conversacion 0 se siembra con MUCHOS mas
 * dispositivos (`--hot-devices`). Cada VU sigue siendo dueño exclusivo de su stream,
 * y aun asi decenas de ellos compiten por la UNICA fila de `conversation_sequences`
 * de esa conversacion — que es exactamente donde vive el `SELECT ... FOR UPDATE`.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.INGRESS_URL || 'http://localhost:8081';
const SEED = JSON.parse(open(__ENV.SEED_FILE || './seed.json'));

const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '5m';

const STREAMS = [];
for (const conversation of SEED.conversations) {
  for (const deviceId of conversation.deviceIds) {
    STREAMS.push({
      conversationId: conversation.conversationId,
      ownerId: conversation.ownerId,
      deviceId,
      devices: conversation.deviceIds,
      caliente: conversation.conversationId === SEED.conversations[0].conversationId,
    });
  }
}

// Nunca mas VUs que streams: dos VUs sobre un stream se pisan el client_sequence.
const MAX_VUS = Math.min(Number(__ENV.MAX_VUS || 200), STREAMS.length);

const enviosUnicos = new Counter('l1_envios_unicos');
const retries = new Counter('l1_retries_equivalentes');
const conflictos = new Counter('l1_conflictos');
const acks = new Counter('l1_acks');
const inesperados = new Counter('l1_respuestas_inesperadas');
const tasaInesperados = new Rate('l1_tasa_inesperados');

const tEnvio = new Trend('l1_duracion_envio', true);
const tRetry = new Trend('l1_duracion_retry', true);
const tConflicto = new Trend('l1_duracion_conflicto', true);
const tAck = new Trend('l1_duracion_ack', true);
const tEnvioCaliente = new Trend('l1_duracion_envio_caliente', true);

export const options = {
  scenarios: {
    l1: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: MAX_VUS,
      maxVUs: MAX_VUS,
      gracefulStop: '30s',
    },
  },
  thresholds: {
    // Los umbrales de ALCANCE para L1, tal cual estan escritos. Si el hardware no los
    // sostiene NO se bajan: se documenta el primer cuello de botella. Un verde
    // obtenido aflojando el umbral no dice nada sobre el sistema.
    'http_req_duration{expected_response:true}': ['p(95)<250', 'p(99)<750'],
    l1_tasa_inesperados: ['rate<0.01'],
    dropped_iterations: ['count==0'],
  },
};

// Estado POR VU. En k6 el scope de modulo es por VU, asi que cada uno lleva el suyo.
let secuencia = 0;
const propios = [];

function miStream() {
  return STREAMS[(__VU - 1) % STREAMS.length];
}

function enviar(stream, seq, clave, texto) {
  return http.post(
    `${BASE}/v1/conversations/${stream.conversationId}/messages`,
    JSON.stringify({
      senderId: stream.ownerId,
      senderDeviceId: stream.deviceId,
      clientMessageId: `l1-${__VU}-${seq}`,
      clientSequence: seq,
      body: texto,
    }),
    {
      headers: { 'content-type': 'application/json', 'Idempotency-Key': clave },
      tags: { name: 'POST /messages' },
    },
  );
}

function registrar(esperado, respuesta) {
  tasaInesperados.add(!esperado);
  if (!esperado) inesperados.add(1);
}

export default function () {
  const dado = Math.random();
  const stream = miStream();

  // 20% acks. Solo sobre mensajes que ESTE VU creo: ackear uno ajeno seria un 404
  // legitimo que ensuciaria la tasa de errores inesperados.
  if (dado < 0.2 && propios.length > 0) {
    const objetivo = propios[Math.floor(Math.random() * propios.length)];
    const dispositivo = objetivo.devices[Math.floor(Math.random() * objetivo.devices.length)];
    const r = http.post(
      `${BASE}/v1/messages/${objetivo.messageId}/acks`,
      JSON.stringify({ deviceId: dispositivo, state: 'delivered' }),
      { headers: { 'content-type': 'application/json' }, tags: { name: 'POST /acks' } },
    );
    tAck.add(r.timings.duration);
    acks.add(1);
    registrar(r.status === 200, r);
    check(r, { 'ack 200': (res) => res.status === 200 });
    return;
  }

  // 15% retry equivalente: MISMA key y MISMO cuerpo. Tiene que devolver 200 con el
  // MISMO messageId. Es I3 medida bajo carga, no en un test unitario.
  if (dado < 0.35 && propios.length > 0) {
    const previo = propios[propios.length - 1];
    const r = enviar(previo.stream, previo.secuencia, previo.clave, previo.texto);
    tRetry.add(r.timings.duration);
    retries.add(1);
    registrar(r.status === 200 && r.json('messageId') === previo.messageId, r);
    check(r, {
      'retry 200': (res) => res.status === 200,
      'retry devuelve el MISMO messageId (I3)': (res) => res.json('messageId') === previo.messageId,
    });
    return;
  }

  // 5% conflicto deliberado: misma key, cuerpo DISTINTO. Tiene que ser 409 y no
  // ejecutar nada. Es I2 medida bajo carga.
  if (dado < 0.4 && propios.length > 0) {
    const previo = propios[propios.length - 1];
    const r = enviar(previo.stream, previo.secuencia, previo.clave, `${previo.texto}-alterado`);
    tConflicto.add(r.timings.duration);
    conflictos.add(1);
    registrar(r.status === 409, r);
    check(r, { 'conflicto 409 (I2)': (res) => res.status === 409 });
    return;
  }

  // El resto: envio unico. La secuencia es un contador por VU, y como cada VU es dueño
  // exclusivo de su stream, nunca colisiona.
  secuencia += 1;
  const clave = `l1-${stream.deviceId}-${secuencia}`;
  const texto = `l1 ${__VU}/${secuencia}`;
  const r = enviar(stream, secuencia, clave, texto);

  tEnvio.add(r.timings.duration);
  if (stream.caliente) tEnvioCaliente.add(r.timings.duration);
  enviosUnicos.add(1);
  registrar(r.status === 201 || r.status === 202, r);
  check(r, { 'envio 201/202': (res) => res.status === 201 || res.status === 202 });

  if (r.status === 201) {
    propios.push({
      messageId: r.json('messageId'),
      stream,
      secuencia,
      clave,
      texto,
      devices: stream.devices,
    });
    // Acotado: el estado por VU no puede crecer sin limite en 5 minutos de corrida.
    if (propios.length > 50) propios.shift();
  }
}
