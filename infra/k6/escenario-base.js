/**
 * Escenario base de carga.
 *
 *   npm run k6:base
 *
 * Es la linea de partida contra la que se van a comparar las corridas con falla
 * inyectada (Toxiproxy, pod kill). Todavia no prueba nada sobre resiliencia: mide el
 * sistema sano para que despues haya un "antes" con el que comparar.
 *
 * DOS DECISIONES QUE NO SON DE ESTILO
 *
 * 1. Entra por el INGRESS, no contra los pods. Pegarle a un pod mide un proceso;
 *    pegarle al ingress mide el sistema —Traefik, el reparto, las tres replicas
 *    compitiendo por el mismo pool de Postgres—, que es lo unico que se parece a un
 *    cliente real. Ademas, `kubectl port-forward` no balancea: fija un pod, y una
 *    corrida hecha asi diria que todo anda bien con dos tercios del sistema sin usar.
 *
 * 2. MODELO ABIERTO (`constant-arrival-rate`). Con VUs en bucle cerrado, cuando el
 *    sistema se pone lento el generador manda MENOS carga —cada VU espera su
 *    respuesta— y la cola nunca se forma: es imposible ver la degradacion, porque el
 *    propio test se autorregula. En modelo abierto las llegadas son independientes de
 *    las respuestas: si el sistema se frena, la cola crece, que es exactamente lo que
 *    va a pasar cuando se mate un pod.
 *
 * CADA VU ES DUEÑO DE UN STREAM. La conversacion y el dispositivo salen del numero de
 * VU, asi que dos VUs nunca comparten un (conversacion, dispositivo). Eso importa:
 * `client_sequence` es el orden del stream de UN dispositivo, y dos VUs escribiendo
 * sobre el mismo stream se pisarian las secuencias y generarian huecos —respuestas 202
 * y mensajes en `buffered`— que no tienen nada que ver con la carga.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.INGRESS_URL || 'http://localhost:8081';
const SEED = JSON.parse(open(__ENV.SEED_FILE || './seed.json'));

// Un stream = un par (conversacion, dispositivo). El seed garantiza que existen.
const STREAMS = [];
for (const conversation of SEED.conversations) {
  for (const deviceId of conversation.deviceIds) {
    STREAMS.push({
      conversationId: conversation.conversationId,
      ownerId: conversation.ownerId,
      deviceId,
    });
  }
}

const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '30s';
// Mas VUs que streams significaria dos VUs sobre el mismo stream. Se acota, y si el
// escenario necesita mas concurrencia, la respuesta es sembrar mas, no compartir.
const MAX_VUS = Math.min(Number(__ENV.MAX_VUS || 40), STREAMS.length);

const creados = new Counter('lab_mensajes_creados');
const replays = new Counter('lab_replays');
const bufferizados = new Counter('lab_bufferizados');

export const options = {
  scenarios: {
    base: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: MAX_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // Umbrales deliberadamente flojos: esta corrida existe para ESTABLECER el p95, no
    // para aprobarlo. Poner un numero exigente antes de tener la primera medicion
    // seria inventarlo. Se aprietan cuando haya varias corridas.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const stream = STREAMS[(__VU - 1) % STREAMS.length];
  const clientSequence = __ITER + 1;

  const body = {
    senderId: stream.ownerId,
    senderDeviceId: stream.deviceId,
    clientMessageId: `k6-${__VU}-${clientSequence}`,
    clientSequence,
    body: `carga ${__VU}/${clientSequence}`,
  };

  const response = http.post(
    `${BASE}/v1/conversations/${stream.conversationId}/messages`,
    JSON.stringify(body),
    {
      headers: {
        'content-type': 'application/json',
        // Deterministica a proposito: un reintento del MISMO mensaje logico tiene que
        // encontrar la respuesta guardada, no crear otro mensaje. Es la propiedad que
        // el laboratorio entero existe para sostener, y bajo carga tambien vale.
        'Idempotency-Key': `k6-${stream.deviceId}-${clientSequence}`,
      },
      tags: { name: 'POST /v1/conversations/:id/messages' },
    },
  );

  if (response.status === 201) creados.add(1);
  else if (response.status === 200) replays.add(1);
  else if (response.status === 202) bufferizados.add(1);

  check(response, {
    'creado, replay o bufferizado': (r) => [200, 201, 202].includes(r.status),
    'nunca 5xx': (r) => r.status < 500,
  });
}
