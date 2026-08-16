/**
 * C2 — la operacion ambigua, contra el ingress y bajo concurrencia.
 *
 *   npm run k6:c2
 *
 * Esto estaba anotado como deuda desde el slice 2: "hoy C2 se prueba a nivel de
 * servicio — se ejecuta, se descarta el resultado y se reintenta. Falta la version que
 * corta el socket DESPUES del commit y reintenta contra el ingress. Necesita el
 * cluster; un 500 antes del commit no sirve para simular esto."
 *
 * COMO SE FABRICA LA AMBIGUEDAD SIN TOCAR EL SERVIDOR. El primer POST sale con un
 * timeout de cliente absurdamente corto. El servidor sigue trabajando y en muchos casos
 * COMMITEA igual; el cliente ya se fue y nunca vio la respuesta. Eso es exactamente la
 * operacion ambigua: el efecto existe o no existe, y el cliente no tiene forma de
 * saberlo. No hace falta un failpoint en el codigo — hace falta un cliente impaciente.
 *
 * Un 500 provocado ANTES del commit no sirve para esto: ahi no hay ambiguedad, no paso
 * nada. Lo dificil es el caso en que si paso.
 *
 * UNA OPERACION AMBIGUA TIENE TRES RESPUESTAS CORRECTAS, NO DOS. La primera version de
 * este escenario exigia 200 o 201 y fallo con 1394 respuestas "inesperadas". No era el
 * sistema: eran 409, y son correctos. Con el cliente rindiendose a los 12ms, el
 * reintento suele llegar mientras el intento original TODAVIA se esta ejecutando, y ahi
 * la respuesta correcta es "esta en curso, no arranco otro" — que es justamente el
 * mecanismo que impide el duplicado. Las metricas de negocio lo confirmaron:
 * `in_progress: 2738`, cero 500.
 *
 * Asi que la asercion no se aflojo para pasar: se corrigio la expectativa y se
 * ENDURECIO. Un 409 es aceptable pero tiene que CONVERGER — reintentando con espera,
 * la operacion tiene que terminar dando 200 o 201 con su messageId. Un 409 eterno
 * seria un cliente que nunca puede saber que paso, y eso si seria un defecto.
 *
 * Lo que en ningun caso puede pasar es que existan DOS mensajes para una sola key, y
 * eso no lo decide este script: lo decide `npm run verify` contra la base al final.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.INGRESS_URL || 'http://localhost:8081';
const SEED = JSON.parse(open(__ENV.SEED_FILE || './seed.json'));
const TIMEOUT_CORTO = __ENV.TIMEOUT_CORTO || '12ms';

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

const ambiguas = new Counter('c2_operaciones_ambiguas');
const reintentoReplay = new Counter('c2_reintento_replay_200');
const reintentoCreado = new Counter('c2_reintento_creado_201');
const reintentoEnCurso = new Counter('c2_reintento_409_en_curso');
const reintentoOtro = new Counter('c2_reintento_inesperado');
const convergio = new Counter('c2_convergio_tras_409');
const noConvergio = new Counter('c2_NO_convergio');
const sinAmbiguedad = new Counter('c2_primer_intento_respondio');
const intentosHastaConverger = new Trend('c2_intentos_hasta_converger');

export const options = {
  scenarios: {
    c2: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 60),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Math.min(Number(__ENV.MAX_VUS || 120), STREAMS.length),
      maxVUs: Math.min(Number(__ENV.MAX_VUS || 120), STREAMS.length),
    },
  },
  thresholds: {
    // Un 5xx o un error de red al reintentar seria el sistema sin saber que hacer con
    // su propio trabajo a medias. El 409 "en curso" NO entra acá: es correcto.
    c2_reintento_inesperado: ['count==0'],
    // Y el 409 tiene que ser transitorio. Si alguno no converge, el cliente se quedo
    // sin forma de averiguar si su envio existe, que es peor que un error claro.
    c2_NO_convergio: ['count==0'],
  },
};

let secuencia = 0;

export default function () {
  const stream = STREAMS[(__VU - 1) % STREAMS.length];
  secuencia += 1;

  const clave = `c2-${stream.deviceId}-${secuencia}`;
  const cuerpo = JSON.stringify({
    senderId: stream.ownerId,
    senderDeviceId: stream.deviceId,
    clientMessageId: `c2-${__VU}-${secuencia}`,
    clientSequence: secuencia,
    body: `ambigua ${__VU}/${secuencia}`,
  });
  const cabeceras = { 'content-type': 'application/json', 'Idempotency-Key': clave };
  const url = `${BASE}/v1/conversations/${stream.conversationId}/messages`;

  // Intento 1: el cliente se rinde antes de que el servidor conteste.
  const primero = http.post(url, cuerpo, {
    headers: cabeceras,
    timeout: TIMEOUT_CORTO,
    tags: { name: 'C2 intento ambiguo' },
  });

  if (primero.status !== 0) {
    // Contesto a tiempo: no hubo ambiguedad, no hay nada que probar en esta iteracion.
    sinAmbiguedad.add(1);
    return;
  }

  ambiguas.add(1);

  // Intento 2: MISMA key, MISMO cuerpo, ahora con paciencia. Es lo que haria un
  // cliente real que no sabe si su envio llego.
  const segundo = http.post(url, cuerpo, {
    headers: cabeceras,
    timeout: '30s',
    tags: { name: 'C2 reintento' },
  });

  if (segundo.status === 200) {
    reintentoReplay.add(1);
  } else if (segundo.status === 201) {
    reintentoCreado.add(1);
  } else if (segundo.status === 409) {
    // "En curso": correcto, pero tiene que converger.
    reintentoEnCurso.add(1);
    let intentos = 1;
    let resuelto = null;

    while (intentos <= 10) {
      sleep(0.2);
      intentos += 1;
      const r = http.post(url, cuerpo, {
        headers: cabeceras,
        timeout: '30s',
        tags: { name: 'C2 reintento con espera' },
      });
      if (r.status === 200 || r.status === 201) {
        resuelto = r;
        break;
      }
      if (r.status !== 409) {
        reintentoOtro.add(1);
        break;
      }
    }

    if (resuelto === null) {
      noConvergio.add(1);
    } else {
      convergio.add(1);
      intentosHastaConverger.add(intentos);
    }

    check(resuelto, {
      'el 409 en curso converge a un resultado con messageId': (r) =>
        r !== null && !!r.json('messageId'),
    });
    return;
  } else {
    reintentoOtro.add(1);
  }

  check(segundo, {
    'el reintento de una ambigua devuelve 200 o 201': (r) => r.status === 200 || r.status === 201,
    'el reintento trae un messageId': (r) =>
      (r.status === 200 || r.status === 201) && !!r.json('messageId'),
  });
}
