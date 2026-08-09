import {
  $, call, clearLog, fillTable, labState, logRequest, mountTop,
  naiveState, nextReplica, renderVerdict, resetLab, setBusy, sleep, uuid,
} from '/lib.js';

mountTop({ current: '/entrega' });

let fixture = null;

const publicar = () =>
  call(nextReplica(), `/v1/conversations/${fixture.conversationId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': `K-${uuid()}` },
    body: {
      senderId: fixture.ownerId,
      senderDeviceId: fixture.deviceIds[0],
      clientMessageId: 'local-1',
      clientSequence: 1,
      body: 'hola',
    },
  });

/** Las mismas 21 confirmaciones para los dos caminos: duplicadas y fuera de orden. */
function plan(devices) {
  return [
    { device: devices[0], state: 'read' },
    { device: devices[0], state: 'delivered' }, // atrasada
    { device: devices[0], state: 'read' },      // duplicada
    ...devices.slice(1).flatMap((device) =>
      Array.from({ length: 9 }, () => ({ device, state: 'delivered' })),
    ),
  ];
}

$('#run').addEventListener('click', async () => {
  setBusy(true);

  try {
    fixture = await resetLab(3);
    clearLog();
    const devices = fixture.deviceIds;

    // ── ingenuo ───────────────────────────────────────────────────────────
    const naiveMsg = await call(nextReplica(), '/lab/naive/messages', {
      method: 'POST',
      body: {
        actorId: fixture.ownerId, key: `K-${uuid()}`,
        conversationId: fixture.conversationId, senderDeviceId: devices[0],
        clientSequence: 1, body: 'hola',
      },
    });
    const naiveId = naiveMsg.payload?.messageId;

    await Promise.all(
      plan(devices).map((a) =>
        call(nextReplica(), '/lab/naive/acks', {
          method: 'POST',
          body: { messageId: naiveId, deviceId: a.device, state: a.state },
        }),
      ),
    );

    const naive = await naiveState();
    const batch = naive.batches[0] ?? { deliveredCount: 0, expectedCount: 3 };

    renderVerdict($('#side-naive'), {
      number: batch.deliveredCount,
      label: `de ${batch.expectedCount} dispositivos confirmaron`,
      chips: [
        { text: `${naive.receipts} recibos para 3 dispositivos`, tone: 'bad' },
        { text: 'progreso imposible', tone: 'bad' },
      ],
      reading: `Sumó <strong>uno por confirmación recibida</strong>, así que el progreso
        dice ${batch.deliveredCount} de ${batch.expectedCount}. Sin un tope, el sistema cree
        que terminó mucho antes de que el tercer dispositivo apareciera: liberaría el trabajo
        y ese dispositivo <strong>nunca recibiría el mensaje</strong>.`,
    });

    // ── protegido ─────────────────────────────────────────────────────────
    const publicado = await publicar();
    logRequest('protegido', publicado);
    const messageId = publicado.payload?.messageId;
    await sleep(120);

    const trabajo = [
      ...plan(devices).map((a) =>
        call(nextReplica(), `/v1/messages/${messageId}/acks`, {
          method: 'POST',
          body: { deviceId: a.device, state: a.state },
        }),
      ),
      // El barrido corriendo EN PARALELO con las confirmaciones: la carrera a forzar.
      ...Array.from({ length: 4 }, () =>
        call(nextReplica(), '/lab/cleanup-deliveries', { method: 'POST' }),
      ),
    ];

    const results = await Promise.all(trabajo);
    results.slice(0, 24).forEach((r) => logRequest('protegido', r));

    const acks = results.filter((r) => r.payload?.state !== undefined);
    const avanzaron = acks.filter((r) => r.payload?.advanced === true).length;
    const sinEfecto = acks.filter((r) => r.payload?.advanced === false).length;
    const limpiezas =
      acks.filter((r) => r.payload?.batch?.cleanedUp).length +
      results.reduce((s, r) => s + (r.payload?.cleaned ?? 0), 0);

    const state = await labState();
    const b = state.batches[0] ?? { deliveredCount: 0, expectedCount: 3 };

    renderVerdict($('#side-guarded'), {
      number: b.deliveredCount,
      label: `de ${b.expectedCount} dispositivos confirmaron`,
      chips: [
        { text: `${avanzaron} movieron el recibo`, tone: 'ok' },
        { text: `${sinEfecto} sin efecto`, tone: 'neutral' },
        { text: `${limpiezas} limpieza`, tone: limpiezas === 1 ? 'ok' : 'bad' },
      ],
      reading: `Las mismas ${acks.length} confirmaciones, y sólo <strong>${avanzaron}</strong>
        movieron algo: una por dispositivo. Las otras ${sinEfecto} actualizaron 0 filas. El
        trabajo se liberó <strong>una sola vez</strong>, aunque la última confirmación y
        cuatro corridas del barrido competían por la misma puerta.`,
    });

    await refrescar();
  } finally {
    setBusy(false);
  }
});

async function refrescar() {
  const state = await labState();
  const nombre = (id) => {
    const i = state.fixture?.deviceIds.indexOf(id) ?? -1;
    return i >= 0 ? `dispositivo ${'ABCDEFGH'[i]}` : String(id).slice(0, 8);
  };

  fillTable($('#tbl-receipts').closest('.tbl-box'), state.receipts, (r) => ({
    cells: [nombre(r.deviceId), `<span class="tag" data-t="${r.state}">${r.state}</span>`, `v${r.version}`],
  }), 'sin recibos todavía');

  fillTable($('#tbl-batches').closest('.tbl-box'), state.batches, (b) => ({
    cells: [
      String(b.messageId).slice(0, 8),
      `${b.deliveredCount}/${b.expectedCount}`,
      b.pendingEnvelopes,
      b.cleanupReason ? `<span class="tag" data-t="${b.cleanupReason}">${b.cleanupReason}</span>` : '—',
    ],
  }), 'sin mensajes todavía');
}

void refrescar();
