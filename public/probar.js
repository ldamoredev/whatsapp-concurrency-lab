import {
  $,
  $$,
  call,
  fillTable,
  labState,
  mountTop,
  nextReplica,
  resetLab,
  uuid,
} from '/lib.js';

mountTop({ current: '/probar' });

let fixture = null;
let lastResult = null;

const campos = {
  key: $('#f-key'),
  body: $('#f-body'),
  cmid: $('#f-cmid'),
  seq: $('#f-seq'),
  sender: $('#f-sender'),
};

/* ── estado del formulario ──────────────────────────────────────────────── */

function pedido() {
  return {
    conversationId: fixture.conversationId,
    senderId: campos.sender.value,
    senderDeviceId: fixture.deviceIds[0],
    clientMessageId: campos.cmid.value,
    clientSequence: Number.parseInt(campos.seq.value, 10) || 1,
    body: campos.body.value,
  };
}

function nuevaKey() {
  campos.key.value = `k-${uuid().slice(0, 8)}`;
}

async function inicializar() {
  fixture = await resetLab(3);

  // El segundo "usuario" no existe en la conversación: sirve para mostrar que la key
  // está scopeada por actor, aunque su envío después falle por otra regla.
  campos.sender.innerHTML = [
    `<option value="${fixture.ownerId}">${fixture.ownerId.slice(0, 8)}… (dueño de la conversación)</option>`,
    `<option value="${uuid()}">otro usuario (al azar)</option>`,
  ].join('');

  nuevaKey();
  campos.body.value = 'hola';
  campos.cmid.value = 'local-1';
  campos.seq.value = '1';

  $('#outcome').innerHTML =
    '<p class="empty-note" style="margin:0">mandá un request para ver la respuesta y el porqué</p>';

  await refrescar();
  await actualizarPreview();
}

/* ── preview del request y de lo que el servidor deriva ─────────────────── */

let previewTimer = null;

function programarPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void actualizarPreview(), 180);
}

async function actualizarPreview() {
  if (!fixture) return;

  const p = pedido();
  const cuerpo = {
    senderId: p.senderId,
    senderDeviceId: p.senderDeviceId,
    clientMessageId: p.clientMessageId,
    clientSequence: p.clientSequence,
    body: p.body,
  };

  $('#preview').innerHTML =
    `<b>POST</b> /v1/conversations/<i>${escapar(p.conversationId.slice(0, 8))}…</i>/messages\n` +
    `<b>Idempotency-Key</b>: <u>${escapar(campos.key.value || '(vacío)')}</u>\n` +
    `<b>Content-Type</b>: application/json\n\n` +
    escapar(JSON.stringify(cuerpo, null, 2));

  // El fingerprint lo calcula el servidor con la misma función que usa el envío real.
  const fp = await call(nextReplica(), '/lab/fingerprint', { method: 'POST', body: p });

  if (fp.payload) {
    $('#d-route').textContent = fp.payload.route;
    $('#d-fp').textContent = fp.payload.fingerprint;
    $('#d-canon').textContent = fp.payload.canonical;
  }
}

const escapar = (t) =>
  String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/* ── mandar ─────────────────────────────────────────────────────────────── */

async function mandar() {
  const p = pedido();
  const key = campos.key.value;

  const antes = await labState();
  const mensajesAntes = antes?.counts.messages ?? 0;

  const result = await call(nextReplica(), `/v1/conversations/${p.conversationId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: {
      senderId: p.senderId,
      senderDeviceId: p.senderDeviceId,
      clientMessageId: p.clientMessageId,
      clientSequence: p.clientSequence,
      body: p.body,
    },
  });

  const despues = await labState();
  const mensajesDespues = despues?.counts.messages ?? 0;

  renderOutcome(result, {
    creoMensaje: mensajesDespues > mensajesAntes,
    mensajesAntes,
    mensajesDespues,
    mismoMessageId:
      lastResult?.payload?.messageId &&
      result.payload?.messageId === lastResult.payload.messageId,
  });

  lastResult = result;
  await refrescar();
}

function renderOutcome(result, info) {
  const p = result.payload ?? {};

  const lectura = explicar(result, info);

  $('#outcome').innerHTML = `
    <div class="outcome__head">
      <span class="outcome__status" data-tone="${tono(result.status)}">HTTP ${result.status}</span>
      <span class="outcome__title">${lectura.titulo}</span>
      <span class="outcome__instance">respondió ${result.instance}</span>
    </div>

    <div class="outcome__grid">
      <div>
        <div class="preview__head">la respuesta</div>
        <pre class="code">${escapar(JSON.stringify(p, null, 2))}</pre>
      </div>
      <div>
        <div class="preview__head">qué cambió en la base</div>
        <div class="derived">
          <div class="derived__row">
            <span class="derived__k">mensajes antes</span>
            <code class="derived__v">${info.mensajesAntes}</code>
          </div>
          <div class="derived__row">
            <span class="derived__k">mensajes después</span>
            <code class="derived__v" style="color:var(--${info.creoMensaje ? 'ok' : 'text-dim'})">${info.mensajesDespues}</code>
          </div>
          <div class="derived__row">
            <span class="derived__k">¿creó algo?</span>
            <code class="derived__v" style="color:var(--${info.creoMensaje ? 'ok' : 'warn'})">${info.creoMensaje ? 'sí' : 'no'}</code>
          </div>
        </div>
        <div class="outcome__why">${lectura.porque}</div>
      </div>
    </div>`;
}

/**
 * La explicación de por qué el servidor decidió lo que decidió.
 *
 * Es lo que convierte al banco en material didáctico y no en un cliente HTTP: el
 * status por sí solo no dice cuál de las dos reglas actuó.
 */
function explicar(result, info) {
  const p = result.payload ?? {};

  if (result.status === 201) {
    return {
      titulo: 'creado',
      porque: `Tu <code>(actor_id, route, key)</code> no estaba en la tabla, así que el
        <code>INSERT</code> ganó y se ejecutó el efecto. La respuesta quedó guardada en esa
        fila: cualquier reintento con esta misma key la va a leer de ahí.`,
    };
  }

  if (result.status === 202) {
    return {
      titulo: 'aceptado, esperando',
      porque: `La key era nueva y el efecto se ejecutó, pero el <code>clientSequence</code>
        llegó adelantado: falta uno anterior. El mensaje existe sin orden visible. Eso es el
        escenario de <a href="/orden">orden y huecos</a>, no idempotencia.`,
    };
  }

  if (result.status === 200) {
    return {
      titulo: info.mismoMessageId ? 'replay — mismo mensaje' : 'replay',
      porque: `Esa key <strong>ya estaba en la tabla</strong> y su fingerprint coincide con
        el de este pedido. El servidor no ejecutó nada: leyó la respuesta guardada y te la
        devolvió. Fijate que <code>mensajes después</code> no subió.`,
    };
  }

  if (p.code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      titulo: 'la key ya es de otro pedido',
      porque: `La key existe, pero el <strong>fingerprint no coincide</strong>: cambiaste algo
        del contenido. El servidor no puede saber cuál de los dos pedidos querías, así que
        <strong>no ejecuta ninguno</strong> y deja intacto el original. Sin esta comparación,
        recibirías la respuesta del pedido anterior creyendo que el tuyo se hizo.`,
    };
  }

  if (p.code === 'CLIENT_SEQUENCE_CONFLICT') {
    return {
      titulo: 'esa posición del stream ya está ocupada',
      porque: `Key nueva, así que la primera red no lo detecta. Lo atrapa la
        <strong>segunda</strong>: ese <code>clientSequence</code> ya lo usó este dispositivo
        para otro contenido. Es la unicidad del dominio, independiente de la del transporte.
        Cambiá el <code>clientSequence</code> y va a pasar.`,
    };
  }

  if (p.code === 'IDEMPOTENCY_IN_PROGRESS') {
    return {
      titulo: 'la operación está en curso',
      porque: `Otro proceso reclamó esa key y todavía no terminó. El servidor no ejecuta ni
        inventa un resultado: pide que reintentes.`,
    };
  }

  if (p.code === 'SENDER_NOT_IN_CONVERSATION') {
    return {
      titulo: 'ese usuario no participa de la conversación',
      porque: `Cambiaste el <code>senderId</code> por uno que no es miembro. Es una regla
        distinta —una FK compuesta en el schema— y actúa antes de que la idempotencia importe.
        Sirve igual para ver que <code>actor_id</code> sale de este campo.`,
    };
  }

  return {
    titulo: p.code ?? 'sin clasificar',
    porque: escapar(p.message ?? ''),
  };
}

const tono = (status) =>
  status === 201 ? 'ok' : status === 200 || status === 202 ? 'replay' : status >= 400 ? 'warn' : 'bad';

/* ── tabla ──────────────────────────────────────────────────────────────── */

async function refrescar() {
  const state = await labState();
  if (!state) return;

  fillTable(
    $('#tbl-ops').closest('.tbl-box'),
    state.operations,
    (o) => ({
      cells: [
        `<span title="${o.actorId}">${o.actorId.slice(0, 8)}…</span>`,
        `<strong>${escapar(o.key)}</strong>`,
        `<span title="${o.fingerprint}">${o.fingerprint.slice(0, 12)}…</span>`,
        `<span class="tag" data-t="${o.status}">${o.status}</span>`,
        o.resourceId ? `${o.resourceId.slice(0, 8)}…` : '—',
        o.responseStatus ?? '—',
      ],
    }),
    'ninguna key reclamada todavía',
  );
}

/* ── experimentos guiados ───────────────────────────────────────────────── */

const experimentos = {
  same: async () => {
    await mandar();
    await mandar();
  },
  body: async () => {
    await mandar();
    campos.body.value = `${campos.body.value} (editado)`;
    await actualizarPreview();
    await mandar();
  },
  key: async () => {
    await mandar();
    nuevaKey();
    await actualizarPreview();
    await mandar();
  },
  actor: async () => {
    await mandar();
    campos.sender.selectedIndex = campos.sender.selectedIndex === 0 ? 1 : 0;
    await actualizarPreview();
    await mandar();
  },
};

/* ── cableado ───────────────────────────────────────────────────────────── */

Object.values(campos).forEach((campo) => {
  campo.addEventListener('input', programarPreview);
  campo.addEventListener('change', programarPreview);
});

$('#send').addEventListener('click', () => void conBloqueo(mandar));
$('#new-key').addEventListener('click', () => {
  nuevaKey();
  void actualizarPreview();
});
$('#reset').addEventListener('click', () => void conBloqueo(inicializar));

$$('.try').forEach((boton) => {
  boton.addEventListener('click', () =>
    void conBloqueo(async () => {
      await inicializar();
      await experimentos[boton.dataset.try]();
    }),
  );
});

async function conBloqueo(fn) {
  const controles = [$('#send'), $('#new-key'), $('#reset'), ...$$('.try')];
  controles.forEach((c) => (c.disabled = true));
  try {
    await fn();
  } finally {
    controles.forEach((c) => (c.disabled = false));
  }
}

void inicializar();
