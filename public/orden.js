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
  renderVerdict,
  resetLab,
  setBusy,
  sleep,
  uuid,
} from '/lib.js';

mountTop({ current: '/orden' });

let fixture = null;

const LLEGADA = [1, 3, 4, 2];

const enviarProtegido = (clientSequence) =>
  call(nextReplica(), `/v1/conversations/${fixture.conversationId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': `K-${uuid()}` },
    body: {
      senderId: fixture.ownerId,
      senderDeviceId: fixture.deviceIds[0],
      clientMessageId: `local-${clientSequence}`,
      clientSequence,
      body: `mensaje ${clientSequence}`,
    },
  });

const publicarIngenuo = (clientSequence) =>
  call(nextReplica(), '/lab/naive/publish', {
    method: 'POST',
    body: {
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.deviceIds[0],
      clientSequence,
      body: `mensaje ${clientSequence}`,
    },
  });

const filaOrden = (m) => ({
  muted: m.serverSequence == null,
  cells: [
    m.serverSequence == null
      ? '<span class="tag" data-t="buffered">esperando</span>'
      : m.serverSequence,
    m.body,
  ],
});

/* ── escenario 1: 1, 3, 4, 2 ────────────────────────────────────────────── */

$('#run').addEventListener('click', async () => {
  setBusy(true);

  try {
    fixture = await resetLab(3);
    clearLog();

    // ── ingenuo: publicar apenas llega ────────────────────────────────────
    for (const seq of LLEGADA) {
      const r = await publicarIngenuo(seq);
      logRequest('ingenuo', r, `publicado en ${r.payload?.serverSequence}`);
      await sleep(60);
    }

    const naive = await naiveState();
    const ordenNaive = naive.order.map((m) => m.body.replace('mensaje ', '')).join(' · ');
    const correcto = ordenNaive === '1 · 2 · 3 · 4';

    fillTable($('#tbl-naive').closest('.tbl-box'), naive.order, filaOrden);
    renderVerdict($('#side-naive'), {
      number: naive.order.filter((m) => m.serverSequence != null).length,
      label: 'mensajes visibles, en este orden:',
      chips: [{ text: ordenNaive, tone: correcto ? 'ok' : 'bad' }],
      reading: `Cada mensaje se publicó en cuanto llegó. La conversación quedó en
        <strong>${ordenNaive}</strong>: el orden de la red, no el del que escribió. Quien
        lo lea ve un salto y <strong>no tiene forma de saber que falta algo</strong>.`,
    });

    // ── protegido: buffering y drenado ────────────────────────────────────
    let drenados = 0;
    let bufferizados = 0;

    for (const seq of LLEGADA) {
      const r = await enviarProtegido(seq);
      logRequest('protegido', r);
      if (r.status === 202) bufferizados += 1;
      drenados += r.payload?.drained ?? 0;
      await sleep(60);
    }

    const state = await labState();
    const publicados = state.messages.filter((m) => m.serverSequence != null);
    const ordenReal = publicados.map((m) => m.body.replace('mensaje ', '')).join(' · ');

    fillTable($('#tbl-guarded').closest('.tbl-box'), state.messages, filaOrden);
    renderVerdict($('#side-guarded'), {
      number: publicados.length,
      label: 'mensajes visibles, en este orden:',
      chips: [
        { text: ordenReal, tone: ordenReal === '1 · 2 · 3 · 4' ? 'ok' : 'bad' },
        { text: `${bufferizados} esperaron`, tone: 'warn' },
        { text: `${drenados} arrastrados al final`, tone: 'neutral' },
      ],
      reading: `El 3 y el 4 llegaron adelantados y quedaron <strong>sin orden visible y sin
        generar un solo envelope</strong>. Cuando llegó el 2, los tres se publicaron en un
        solo commit — en el orden del stream, no en el de llegada.`,
    });

    await refrescarStreams();
  } finally {
    setBusy(false);
  }
});

/* ── escenario 2: el hueco que vence ────────────────────────────────────── */

$('#run-gap').addEventListener('click', async () => {
  setBusy(true);

  try {
    fixture = await resetLab(3);
    clearLog();

    // Se deja el hueco: se manda el 2 sin haber mandado el 1.
    const adelantado = await enviarProtegido(2);
    logRequest('protegido', adelantado);
    await sleep(120);

    // El barrido de expiración, con los plazos adelantados para no esperar.
    const barrido = await call(nextReplica(), '/lab/expire-gaps?force=true', {
      method: 'POST',
    });
    logRequest('cron', barrido, `${barrido.payload?.expired ?? 0} stream(s) vencidos`);
    await sleep(120);

    // Con el stream bloqueado, cualquier otro mensaje se rechaza.
    const rechazado = await enviarProtegido(3);
    logRequest('protegido', rechazado);

    const state = await labState();
    const publicados = state.messages.filter((m) => m.serverSequence != null).length;
    const esperando = state.messages.filter((m) => m.serverSequence == null).length;
    const bloqueado = rechazado.payload?.code === 'STREAM_RESYNC_REQUIRED';

    // El camino "saltear el hueco" no se ejecuta: se describe lo que habría pasado,
    // porque el sistema real no tiene forma de hacerlo — y eso es el punto.
    renderVerdict($('#side-naive-2'), {
      number: 2,
      label: 'mensajes visibles, con un agujero adentro',
      chips: [
        { text: 'orden: 2 · 3', tone: 'bad' },
        { text: 'el 1 nunca existió', tone: 'bad' },
      ],
      reading: `Publicar igual deja la conversación con un salto permanente y
        <strong>sin ninguna señal</strong>. Nadie recibe un error; simplemente falta algo
        que nadie va a echar de menos. Este camino no existe en el sistema: no hay forma de
        pedirlo.`,
    });

    renderVerdict($('#side-guarded-2'), {
      number: publicados,
      label: 'mensajes visibles',
      chips: [
        { text: `${esperando} sigue esperando`, tone: 'warn' },
        {
          text: bloqueado ? 'stream bloqueado' : 'stream NO bloqueado',
          tone: bloqueado ? 'ok' : 'bad',
        },
        {
          text: `pide el ${rechazado.payload?.nextClientSequence ?? '—'}`,
          tone: 'neutral',
        },
      ],
      reading: `Vencer el plazo <strong>no publicó nada</strong>. El stream pasó a
        <code>resync_required</code> y el error le dice al cliente exactamente qué reenviar.
        La decisión de saltar el hueco existe, pero es del cliente y por un endpoint
        explícito — nunca del servidor por cansancio.`,
    });

    await refrescarStreams();
  } finally {
    setBusy(false);
  }
});

async function refrescarStreams() {
  const state = await labState();
  const nombre = (id) => {
    const i = state.fixture?.deviceIds.indexOf(id) ?? -1;
    return i >= 0 ? `dispositivo ${'ABCDEFGH'[i]}` : String(id).slice(0, 8);
  };

  fillTable(
    $('#tbl-streams').closest('.tbl-box'),
    state.streams,
    (s) => ({
      flag: s.state === 'resync_required' ? 'bad' : undefined,
      cells: [
        nombre(s.deviceId),
        s.nextClientSequence,
        `<span class="tag" data-t="${s.state}">${s.state}</span>`,
        s.gapDeadline ? 'corriendo' : '—',
      ],
    }),
    'ningún dispositivo escribió todavía',
  );
}

void refrescarStreams();
