import {
  $,
  call,
  clearLog,
  fillTable,
  labState,
  logRequest,
  mountTop,
  naiveState,
  nextReplica,
  resetLab,
  renderVerdict,
  setBusy,
  uuid,
} from '/lib.js';

mountTop({ current: '/idempotencia' });

let fixture = null;

async function ensureFixture() {
  fixture = await resetLab(3);
  clearLog();
  return fixture;
}

/** El mismo pedido, mandado por los dos caminos. */
function pedido(key, clientSequence, body = 'hola') {
  return {
    key,
    conversationId: fixture.conversationId,
    actorId: fixture.ownerId,
    senderId: fixture.ownerId,
    senderDeviceId: fixture.deviceIds[0],
    clientMessageId: `local-${clientSequence}`,
    clientSequence,
    body,
  };
}

const enviarProtegido = (p) =>
  call(nextReplica(), `/v1/conversations/${p.conversationId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': p.key },
    body: {
      senderId: p.senderId,
      senderDeviceId: p.senderDeviceId,
      clientMessageId: p.clientMessageId,
      clientSequence: p.clientSequence,
      body: p.body,
    },
  });

const enviarIngenuo = (p) =>
  call(nextReplica(), '/lab/naive/messages', { method: 'POST', body: p });

/* ── escenario 1: la carrera ────────────────────────────────────────────── */

$('#run').addEventListener('click', async () => {
  setBusy(true);

  try {
    await ensureFixture();
    const total = 60;

    // ── camino ingenuo ────────────────────────────────────────────────────
    const keyIngenua = `K-${uuid()}`;
    const ingenuos = await Promise.all(
      Array.from({ length: total }, () => enviarIngenuo(pedido(keyIngenua, 1))),
    );
    ingenuos.slice(0, 20).forEach((r) => logRequest('ingenuo', r));

    const naive = await naiveState();
    const creados = ingenuos.filter((r) => r.payload?.created).length;

    renderVerdict($('#side-naive'), {
      number: naive.messages,
      label: naive.messages === 1 ? 'mensaje creado' : 'mensajes creados',
      chips: [
        { text: `${creados} se creyeron los primeros`, tone: 'bad' },
        { text: `${total - creados} leyeron uno existente`, tone: 'neutral' },
      ],
      reading:
        naive.messages > 1
          ? `<strong>${naive.messages} requests</strong> leyeron "no existe" antes de que
             ninguno terminara de escribir, y cada uno creó su propio mensaje. El
             destinatario recibiría ${naive.messages} copias del mismo texto.
             <br><br>Volvé a correrlo: el número <strong>cambia cada vez</strong>. A veces
             son 2, a veces 15. Eso es lo que hace peligrosa a una condición de carrera —
             no falla siempre, falla <em>a veces</em>, y en desarrollo casi nunca.`
          : `Esta vez el primer request alcanzó a escribir antes que los demás leyeran, y
             no hubo duplicado. <strong>El bug sigue estando ahí.</strong> Corré de nuevo:
             una condición de carrera no falla siempre, falla a veces — y por eso pasa el
             code review y aparece en producción.`,
    });

    // ── camino protegido ──────────────────────────────────────────────────
    const keyProtegida = `K-${uuid()}`;
    const protegidos = await Promise.all(
      Array.from({ length: total }, () => enviarProtegido(pedido(keyProtegida, 1))),
    );
    protegidos.slice(0, 20).forEach((r) => logRequest('protegido', r));

    const state = await labState();
    const creado = protegidos.filter((r) => r.status === 201).length;
    const replay = protegidos.filter((r) => r.status === 200).length;
    const enCurso = protegidos.filter((r) => r.status === 409).length;
    const ganadora = protegidos.find((r) => r.status === 201)?.instance ?? '—';

    renderVerdict($('#side-guarded'), {
      number: state.counts.messages,
      label: state.counts.messages === 1 ? 'mensaje creado' : 'mensajes creados',
      chips: [
        { text: `${creado} × 201 creado`, tone: 'ok' },
        { text: `${replay} × 200 replay`, tone: 'neutral' },
        { text: `${enCurso} × 409 en curso`, tone: 'warn' },
      ],
      reading: `Sólo <strong>${ganadora}</strong> ganó el INSERT. Los otros
        ${total - creado} chocaron contra la constraint y, en vez de fallar, leyeron el
        resultado que ${ganadora} ya había dejado en la base. Ninguna réplica sabía de la
        existencia de las otras.`,
    });

    await refrescarTablas();
  } finally {
    setBusy(false);
  }
});

/* ── escenario 2: la key reusada con otro cuerpo ────────────────────────── */

$('#run-conflict').addEventListener('click', async () => {
  setBusy(true);

  try {
    await ensureFixture();
    const total = 30;

    const keyIngenua = `K-${uuid()}`;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        enviarIngenuo(pedido(keyIngenua, 1, `variante ${i}`)),
      ),
    );

    const naive = await naiveState();
    renderVerdict($('#side-naive-2'), {
      number: naive.messages,
      label: 'mensajes con contenidos distintos',
      chips: [{ text: 'ninguno rechazado', tone: 'bad' }],
      reading: `Sin comparar el contenido, la key sola no distingue un reintento de un
        pedido nuevo. Se guardaron <strong>${naive.messages} mensajes con textos
        diferentes</strong>, y quien reintentó recibió la respuesta de otro pedido.`,
    });

    const keyProtegida = `K-${uuid()}`;
    const protegidos = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        enviarProtegido(pedido(keyProtegida, 1, `variante ${i}`)),
      ),
    );
    protegidos.slice(0, 12).forEach((r) => logRequest('protegido', r));

    const state = await labState();
    const reusada = protegidos.filter(
      (r) => r.payload?.code === 'IDEMPOTENCY_KEY_REUSED',
    ).length;

    renderVerdict($('#side-guarded-2'), {
      number: state.counts.messages,
      label: state.counts.messages === 1 ? 'mensaje creado' : 'mensajes creados',
      chips: [
        { text: `${reusada} × 409 key reusada`, tone: 'warn' },
        { text: 'efecto original intacto', tone: 'ok' },
      ],
      reading: `El <strong>fingerprint</strong> —un hash del pedido— no coincide con el
        guardado, así que el sistema <strong>ni siquiera intenta ejecutar</strong>. Sin él,
        un cliente con un bug recibiría la respuesta del pedido anterior creyendo que el
        suyo se hizo.`,
    });

    await refrescarTablas();
  } finally {
    setBusy(false);
  }
});

async function refrescarTablas() {
  const state = await labState();

  fillTable(
    $('#tbl-ops').closest('.tbl-box'),
    state.operations,
    (o) => ({
      cells: [
        o.key.length > 20 ? `${o.key.slice(0, 18)}…` : o.key,
        `<span class="tag" data-t="${o.status}">${o.status}</span>`,
        o.attempt,
        o.responseStatus ?? '—',
      ],
    }),
    'sin operaciones todavía',
  );
}

void refrescarTablas();
