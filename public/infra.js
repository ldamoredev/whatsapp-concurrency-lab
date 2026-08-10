import {
  $, MODE, call, fillTable, labState, logRequest, mountTop,
  nextReplica, pollReplicas, resetLab, setBusy, uuid,
} from '/lib.js';

mountTop({ current: '/infra' });

$('#kill-note').innerHTML =
  MODE === 'ingress'
    ? 'Probá <code>kubectl -n whatsapp-lab delete pod &lt;alguno&gt;</code> con esta página abierta: Kubernetes lo recrea, y los escenarios siguen andando mientras tanto.'
    : 'Probá <code>docker stop whatsapp-lab-api-2</code> con esta página abierta: la tarjeta se pone en rojo y los escenarios siguen andando con las otras dos.';

let busy = false;

async function refrescar() {
  if (busy) return;
  const state = await labState();
  if (!state) return;

  const nombre = (id) => {
    const i = state.fixture?.deviceIds.indexOf(id) ?? -1;
    return i >= 0 ? `dispositivo ${'ABCDEFGH'[i]}` : String(id).slice(0, 8);
  };

  $('#hint-counter').textContent = state.conversation
    ? `próximo server_sequence: ${state.conversation.nextServerSequence}`
    : '—';

  fillTable($('#tbl-messages').closest('.tbl-box'), state.messages, (m) => ({
    muted: m.serverSequence == null,
    cells: [
      m.clientSequence,
      m.serverSequence ?? '—',
      `<span class="tag" data-t="${m.status}">${m.status}</span>`,
      m.body,
    ],
  }), 'sin mensajes');

  fillTable($('#tbl-streams').closest('.tbl-box'), state.streams, (s) => ({
    flag: s.state === 'resync_required' ? 'bad' : undefined,
    cells: [
      nombre(s.deviceId),
      s.nextClientSequence,
      `<span class="tag" data-t="${s.state}">${s.state}</span>`,
      s.gapDeadline ? 'corriendo' : '—',
    ],
  }), 'ningún dispositivo escribió');

  fillTable($('#tbl-batches').closest('.tbl-box'), state.batches, (b) => ({
    cells: [
      String(b.messageId).slice(0, 8),
      `${b.deliveredCount}/${b.expectedCount}`,
      b.pendingEnvelopes,
      b.cleanupReason ? `<span class="tag" data-t="${b.cleanupReason}">${b.cleanupReason}</span>` : '—',
    ],
  }), 'sin entregas');

  fillTable($('#tbl-ops').closest('.tbl-box'), state.operations, (o) => ({
    cells: [
      o.key.length > 20 ? `${o.key.slice(0, 18)}…` : o.key,
      `<span class="tag" data-t="${o.status}">${o.status}</span>`,
      o.attempt,
      o.responseStatus ?? '—',
    ],
  }), 'sin operaciones');
}

$('#run-load').addEventListener('click', async () => {
  setBusy(true);
  busy = true;

  try {
    const fixture = await resetLab(3);
    const total = 200;
    const keyFija = `K-fijo-${uuid()}`;
    const results = [];

    for (let tanda = 0; tanda < 4; tanda += 1) {
      const lote = await Promise.all(
        Array.from({ length: total / 4 }, (_, i) => {
          const index = tanda * (total / 4) + i;
          // Mezcla: reintentos equivalentes de una key fija y envíos únicos.
          const esReintento = index % 5 === 0;
          return call(nextReplica(), `/v1/conversations/${fixture.conversationId}/messages`, {
            method: 'POST',
            headers: { 'idempotency-key': esReintento ? keyFija : `K-${uuid()}` },
            body: {
              senderId: fixture.ownerId,
              senderDeviceId: fixture.deviceIds[0],
              clientMessageId: `local-${esReintento ? 1 : index + 1}`,
              clientSequence: esReintento ? 1 : index + 1,
              body: esReintento ? 'reintento' : `mensaje ${index + 1}`,
            },
          });
        }),
      );
      results.push(...lote);
      busy = false;
      await refrescar();
      busy = true;
    }

    results.slice(0, 40).forEach((r) => logRequest('carga', r));

    const porStatus = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const inesperados = results.filter((r) => ![200, 201, 202, 409].includes(r.status)).length;

    $('#load-result').innerHTML = [
      ...Object.entries(porStatus).map(
        ([status, n]) =>
          `<span class="chip" data-tone="${status === '201' ? 'ok' : status === '409' ? 'warn' : 'neutral'}">HTTP ${status}: ${n}</span>`,
      ),
      `<span class="chip" data-tone="${inesperados === 0 ? 'ok' : 'bad'}">inesperados: ${inesperados}</span>`,
    ].join('');
  } finally {
    busy = false;
    setBusy(false);
    await refrescar();
    await pollReplicas();
  }
});

void pollReplicas();
void refrescar();
setInterval(() => void pollReplicas(), 3000);
setInterval(() => void refrescar(), 1500);
