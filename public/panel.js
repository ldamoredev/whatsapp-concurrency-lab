/* Panel del laboratorio.
 *
 * Sin framework y sin build step, a proposito: el proyecto se explica leyendo el
 * codigo, y una capa de herramientas mas seria una capa mas que explicar.
 *
 * Idea central: los escenarios se disparan DESDE EL NAVEGADOR, repartiendo los
 * requests entre las tres replicas. Si se orquestaran del lado del servidor, todo
 * pasaria por un solo proceso y no se demostraria nada.
 */

const REPLICAS = ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'];

const state = {
  fixture: null,
  replicas: REPLICAS.map((url) => ({ url, instanceId: '—', status: 'down', posts: 0 })),
  log: [],
  running: false,
  nextReplica: 0,
};

const $ = (id) => document.getElementById(id);
const uuid = () => crypto.randomUUID();

/**
 * Round-robin del lado del cliente.
 *
 * Sustituto explicito y temporal del balanceador: Compose no trae uno y el alcance
 * prohibe agregar Nginx. Con k3d, Traefik reparte contra una sola URL y esto se borra.
 */
function nextReplica() {
  const replica = state.replicas[state.nextReplica % state.replicas.length];
  state.nextReplica += 1;
  return replica.url;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function call(url, path, options = {}) {
  const started = performance.now();

  try {
    const response = await fetch(url + path, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
    });

    const ms = Math.round(performance.now() - started);
    const instance = response.headers.get('x-instance-id') ?? '?';
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* respuestas sin cuerpo */
    }

    return { ok: response.ok, status: response.status, instance, payload, ms };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      instance: '—',
      payload: { code: 'NETWORK', message: String(error) },
      ms: Math.round(performance.now() - started),
    };
  }
}

function sendMessage(url, { key, clientSequence, body, clientMessageId }) {
  const fixture = state.fixture;
  return call(url, `/v1/conversations/${fixture.conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      senderId: fixture.ownerId,
      senderDeviceId: fixture.deviceIds[0],
      clientMessageId: clientMessageId ?? `local-${clientSequence}`,
      clientSequence,
      body: body ?? `mensaje ${clientSequence}`,
    }),
  });
}

function sendAck(url, messageId, deviceId, ackState) {
  return call(url, `/v1/messages/${messageId}/acks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, state: ackState }),
  });
}

// ── log ─────────────────────────────────────────────────────────────────────

function logRequest(label, result) {
  state.log.unshift({
    instance: result.instance,
    label,
    status: result.status,
    detail: describe(result),
    ms: result.ms,
  });
  state.log = state.log.slice(0, 120);
}

function describe(result) {
  const p = result.payload ?? {};
  if (p.code) return `${p.code}`;
  if (p.messageId) {
    const orden = p.serverSequence === null ? 'sin orden' : `server ${p.serverSequence}`;
    return `${p.status ?? ''} · ${orden} · ${String(p.messageId).slice(0, 8)}`;
  }
  if (p.state) {
    return `${p.state}${p.advanced === false ? ' (sin efecto)' : ''}`;
  }
  return '';
}

function toneOf(status) {
  if (status === 201) return 'ok';
  if (status === 200 || status === 202) return 'replay';
  if (status >= 400 && status < 500) return 'warn';
  return 'bad';
}

// ── escenarios ──────────────────────────────────────────────────────────────

const scenarios = {
  async c1() {
    const key = `K-${uuid()}`;
    const seq = await nextFreeSequence();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => sendMessage(nextReplica(), { key, clientSequence: seq })),
    );
    results.forEach((r) => logRequest('C1', r));

    const creados = results.filter((r) => r.status === 201).length;
    const replays = results.filter((r) => r.status === 200).length;
    const enCurso = results.filter((r) => r.status === 409).length;
    const ganadora = results.find((r) => r.status === 201)?.instance ?? '—';

    return {
      title: '100 requests concurrentes con la misma idempotency key',
      chips: [
        { text: `201 creado ${creados}`, tone: creados === 1 ? 'ok' : 'bad' },
        { text: `200 replay ${replays}`, tone: 'neutral' },
        { text: `409 en curso ${enCurso}`, tone: 'warn' },
        { text: `ganó ${ganadora}`, tone: 'neutral' },
      ],
      split: countBy(results.map((r) => r.instance)),
      note:
        creados === 1
          ? 'Exactamente una réplica creó el mensaje. Las otras leyeron el resultado que aquélla dejó en la base, o vieron la operación en curso. Ninguna sabía de la existencia de las otras: la única autoridad compartida es el UNIQUE (actor_id, route, key).'
          : `Se crearon ${creados} mensajes. Eso es una violación de I1.`,
    };
  },

  async c1b() {
    const key = `K-${uuid()}`;
    const seq = await nextFreeSequence();

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        sendMessage(nextReplica(), { key, clientSequence: seq, body: `variante ${i}` }),
      ),
    );
    results.forEach((r) => logRequest('I2', r));

    const creados = results.filter((r) => r.status === 201).length;
    const conflictos = results.filter(
      (r) => r.payload?.code === 'IDEMPOTENCY_KEY_REUSED',
    ).length;

    return {
      title: '30 requests con la misma key y cuerpos DISTINTOS',
      chips: [
        { text: `201 creado ${creados}`, tone: creados <= 1 ? 'ok' : 'bad' },
        { text: `409 key reusada ${conflictos}`, tone: 'warn' },
      ],
      split: countBy(results.map((r) => r.instance)),
      note: 'El fingerprint del pedido no coincide con el guardado, así que el sistema ni siquiera intenta ejecutar: responde 409 y deja intacto el efecto original. Sin fingerprint, un cliente con un bug recibiría la respuesta del pedido anterior creyendo que el suyo se hizo.',
    };
  },

  async c3() {
    const base = await nextFreeSequence();
    const orden = [base, base + 2, base + 3, base + 1];
    const results = [];

    for (const seq of orden) {
      const r = await sendMessage(nextReplica(), { key: `K-${uuid()}`, clientSequence: seq });
      results.push(r);
      logRequest('C3', r);
      await sleep(120);
    }

    const buffered = results.filter((r) => r.status === 202).length;
    const drenados = results.at(-1)?.payload?.drained ?? 0;

    return {
      title: `envío ${orden.join(', ')} — el ${base + 1} llega último`,
      chips: [
        { text: `202 esperando ${buffered}`, tone: 'warn' },
        { text: `arrastró ${drenados}`, tone: drenados === 2 ? 'ok' : 'warn' },
      ],
      note: 'Los adelantados quedaron en la base pero SIN server_sequence y sin generar un solo envelope: para la conversación todavía no existían. Al llegar el que faltaba, los tres se publicaron en un solo commit, en el orden del stream y no en el de llegada.',
    };
  },

  async gap() {
    const base = await nextFreeSequence();

    // Se deja un hueco abierto a proposito: se manda base+1 sin mandar base.
    const adelantado = await sendMessage(nextReplica(), {
      key: `K-${uuid()}`,
      clientSequence: base + 1,
    });
    logRequest('C3', adelantado);
    await sleep(150);

    // El barrido de expiracion, con los deadlines adelantados para no esperar.
    const barrido = await call(nextReplica(), '/lab/expire-gaps?force=true', { method: 'POST' });
    logRequest('cron', barrido);
    await sleep(150);

    // Ahora el stream esta bloqueado: cualquier otro mensaje se rechaza.
    const rechazado = await sendMessage(nextReplica(), {
      key: `K-${uuid()}`,
      clientSequence: base + 2,
    });
    logRequest('C3', rechazado);

    const bloqueado = rechazado.payload?.code === 'STREAM_RESYNC_REQUIRED';

    return {
      title: 'un hueco que nadie completó',
      chips: [
        { text: `streams vencidos ${barrido.payload?.expired ?? 0}`, tone: 'warn' },
        {
          text: bloqueado ? 'stream bloqueado' : 'stream NO bloqueado',
          tone: bloqueado ? 'ok' : 'bad',
        },
        { text: `esperado: ${rechazado.payload?.nextClientSequence ?? '—'}`, tone: 'neutral' },
      ],
      note: 'Vencer el plazo NO publicó el mensaje adelantado. El servidor nunca saltea un hueco por su cuenta: eso dejaría al destinatario con una conversación con un salto y sin forma de saberlo. El stream queda bloqueado hasta que el cliente reenvíe el que falta o pida un resync explícito.',
    };
  },

  async c4() {
    const seq = await nextFreeSequence();
    const publicado = await sendMessage(nextReplica(), {
      key: `K-${uuid()}`,
      clientSequence: seq,
    });
    logRequest('C4', publicado);

    const messageId = publicado.payload?.messageId;
    if (!messageId || publicado.payload?.status !== 'published') {
      return {
        title: 'no se pudo publicar el mensaje para ackear',
        chips: [{ text: publicado.payload?.code ?? `HTTP ${publicado.status}`, tone: 'bad' }],
        note: 'El stream puede estar bloqueado por un hueco. Reiniciá el laboratorio y probá de nuevo.',
      };
    }

    await sleep(150);
    const devices = state.fixture.deviceIds;

    // Acks duplicados, fuera de orden y concurrentes, repartidos entre replicas, con
    // el CronJob de cleanup corriendo en paralelo para forzar la carrera.
    const trabajo = [
      sendAck(nextReplica(), messageId, devices[0], 'read'),
      sendAck(nextReplica(), messageId, devices[0], 'delivered'), // atrasado
      sendAck(nextReplica(), messageId, devices[0], 'read'), // duplicado
      ...devices.slice(1).flatMap((deviceId) =>
        Array.from({ length: 6 }, () => sendAck(nextReplica(), messageId, deviceId, 'delivered')),
      ),
      ...Array.from({ length: 4 }, () =>
        call(nextReplica(), '/lab/cleanup-deliveries', { method: 'POST' }),
      ),
    ];

    const results = await Promise.all(trabajo);
    results.forEach((r) => logRequest('C4', r));

    const acks = results.filter((r) => r.payload?.state !== undefined);
    const avanzaron = acks.filter((r) => r.payload?.advanced === true).length;
    const sinEfecto = acks.filter((r) => r.payload?.advanced === false).length;
    const limpiezas =
      acks.filter((r) => r.payload?.batch?.cleanedUp === true).length +
      results.reduce((suma, r) => suma + (r.payload?.cleaned ?? 0), 0);

    return {
      title: `${acks.length} acks + 4 corridas del CronJob, todo concurrente`,
      chips: [
        { text: `avanzaron ${avanzaron}`, tone: avanzaron === devices.length ? 'ok' : 'warn' },
        { text: `sin efecto ${sinEfecto}`, tone: 'neutral' },
        { text: `cleanups ${limpiezas}`, tone: limpiezas === 1 ? 'ok' : 'bad' },
      ],
      split: countBy(results.map((r) => r.instance)),
      note: 'Sólo un ack por dispositivo movió el recibo: los duplicados y los atrasados actualizaron 0 filas. Y el trabajo de entrega se liberó exactamente una vez, aunque el último ack y cuatro corridas del CronJob competían por la misma puerta.',
    };
  },

  async kill() {
    const base = await nextFreeSequence();
    const total = 200;
    const results = [];

    for (let batch = 0; batch < 4; batch += 1) {
      const tanda = await Promise.all(
        Array.from({ length: total / 4 }, (_, i) => {
          const index = batch * (total / 4) + i;
          // Mezcla: envíos únicos, retries equivalentes y conflictos deliberados.
          if (index % 5 === 0) {
            return sendMessage(nextReplica(), {
              key: `K-fijo-${base}`,
              clientSequence: base,
            });
          }
          return sendMessage(nextReplica(), {
            key: `K-${uuid()}`,
            clientSequence: base + index,
          });
        }),
      );
      results.push(...tanda);
      await refresh();
    }

    results.slice(0, 60).forEach((r) => logRequest('carga', r));

    const porStatus = countBy(results.map((r) => String(r.status)));
    const inesperados = results.filter((r) => ![200, 201, 202, 409].includes(r.status)).length;

    return {
      title: `${total} envíos mezclando únicos, retries y conflictos`,
      chips: [
        ...Object.entries(porStatus).map(([status, n]) => ({
          text: `${status}: ${n}`,
          tone: status === '201' ? 'ok' : status === '409' ? 'warn' : 'neutral',
        })),
        { text: `inesperados ${inesperados}`, tone: inesperados === 0 ? 'ok' : 'bad' },
      ],
      split: countBy(results.map((r) => r.instance)),
      note: 'Mirá el contador de invariantes arriba a la derecha: tiene que seguir en cero. Contar respuestas 2xx no demostraría nada — lo que prueba algo son las consultas de I4, I5, I8 e I9 corriendo contra la base después de la carga.',
    };
  },
};

async function nextFreeSequence() {
  const snapshot = await call(state.replicas[0].url, '/lab/state');
  const streams = snapshot.payload?.streams ?? [];
  const mine = streams.find((s) => s.deviceId === state.fixture?.deviceIds[0]);
  return mine ? mine.nextClientSequence : 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

// ── render ──────────────────────────────────────────────────────────────────

function renderReplicas() {
  const max = Math.max(1, ...state.replicas.map((r) => r.posts));

  $('replicas').innerHTML = state.replicas
    .map(
      (r) => `
      <div class="replica">
        <div class="replica__head">
          <span class="dot" data-state="${r.status}"></span>
          <span class="replica__id">${r.instanceId}</span>
          <span class="replica__url">${r.url.replace('http://localhost', ':')}</span>
        </div>
        <div class="replica__stats">
          <div><div class="stat__k">estado</div><div class="stat__v" style="font-size:12px">${r.status}</div></div>
          <div><div class="stat__k">POST</div><div class="stat__v">${r.posts}</div></div>
          <div><div class="stat__k">pool</div><div class="stat__v" style="font-size:12px">${r.pool ?? '—'}</div></div>
        </div>
        <div class="bar"><div class="bar__fill" style="width:${(r.posts / max) * 100}%"></div></div>
      </div>`,
    )
    .join('');
}

function renderResult(result) {
  const box = $('result');
  box.hidden = false;

  const chips = (result.chips ?? [])
    .map((c) => `<span class="chip" data-tone="${c.tone ?? 'neutral'}">${c.text}</span>`)
    .join('');

  const total = Object.values(result.split ?? {}).reduce((a, b) => a + b, 0);
  const split = result.split
    ? Object.entries(result.split)
        .sort()
        .map(
          ([k, v]) => `
        <div class="split">
          <span class="mono-dim">${k}</span>
          <span class="split__bar"><span class="split__fill" style="width:${(v / total) * 100}%"></span></span>
          <span>${v}</span>
        </div>`,
        )
        .join('')
    : '';

  box.innerHTML = `
    <div class="result__title">${result.title}</div>
    <div class="result__chips">${chips}</div>
    ${split}
    <div class="result__note">${result.note}</div>`;
}

function renderTables(snapshot) {
  const shortDevice = (id) => {
    const index = state.fixture?.deviceIds.indexOf(id) ?? -1;
    return index >= 0 ? `dispositivo ${'ABCDEFGH'[index]}` : String(id).slice(0, 8);
  };

  $('counter-hint').textContent = snapshot.conversation
    ? `próximo server_sequence: ${snapshot.conversation.nextServerSequence}`
    : '—';

  fillTable('tbl-messages', snapshot.messages, (m) => ({
    muted: m.serverSequence === null,
    cells: [
      m.clientSequence,
      m.serverSequence ?? '—',
      `<span class="tag" data-t="${m.status}">${m.status}</span>`,
      m.body,
    ],
  }));

  fillTable('tbl-streams', snapshot.streams, (s) => ({
    cells: [
      shortDevice(s.deviceId),
      s.nextClientSequence,
      `<span class="tag" data-t="${s.state}">${s.state}</span>`,
      s.gapDeadline ? 'corriendo' : '—',
    ],
  }));

  fillTable('tbl-batches', snapshot.batches, (b) => ({
    cells: [
      String(b.messageId).slice(0, 8),
      `${b.deliveredCount}/${b.expectedCount}`,
      b.pendingEnvelopes,
      b.cleanupReason
        ? `<span class="tag" data-t="${b.cleanupReason}">${b.cleanupReason}</span>`
        : '—',
    ],
  }));

  fillTable('tbl-operations', snapshot.operations, (o) => ({
    cells: [
      o.key.length > 18 ? `${o.key.slice(0, 16)}…` : o.key,
      `<span class="tag" data-t="${o.status}">${o.status}</span>`,
      o.attempt,
      o.responseStatus ?? '—',
    ],
  }));
}

function fillTable(id, rows, mapper) {
  const tbody = $(id).querySelector('tbody');
  const columns = $(id).querySelectorAll('thead th').length;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr class="empty"><td colspan="${columns}">sin datos</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const { cells, muted } = mapper(row);
      return `<tr data-muted="${Boolean(muted)}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');
}

function renderLog() {
  const box = $('log');

  if (state.log.length === 0) {
    box.innerHTML = '<div class="log__empty">todavía no se disparó ningún escenario</div>';
    return;
  }

  box.innerHTML = state.log
    .map(
      (entry) => `
      <div class="log__row">
        <span class="log__instance">${entry.instance}</span>
        <span class="mono-dim">${entry.label}</span>
        <span class="log__status" data-tone="${toneOf(entry.status)}">${entry.status}</span>
        <span class="log__detail">${entry.detail}</span>
        <span class="log__ms">${entry.ms}ms</span>
      </div>`,
    )
    .join('');
}

function renderInvariants(violations) {
  const value = $('invariants-value');
  const broken = violations && violations.length > 0;

  value.dataset.broken = String(Boolean(broken));
  value.textContent = broken
    ? violations.map((v) => `${v.invariant}: ${v.detail}`).join(' · ')
    : 'I4 · I5 · I8 · I9 — sin violaciones';
}

// ── ciclo de refresco ───────────────────────────────────────────────────────

async function pollReplicas() {
  await Promise.all(
    state.replicas.map(async (replica) => {
      const health = await call(replica.url, '/health/ready');

      if (health.status === 0) {
        replica.status = 'down';
        replica.instanceId = replica.instanceId === '—' ? '—' : replica.instanceId;
        return;
      }

      replica.status = health.payload?.status ?? 'down';
      replica.instanceId = health.payload?.instanceId ?? replica.instanceId;

      const metrics = await fetch(`${replica.url}/metrics`)
        .then((r) => r.text())
        .catch(() => '');

      replica.posts = metrics
        .split('\n')
        .filter((line) => line.startsWith('lab_http_requests_total{method="POST"'))
        .reduce((sum, line) => sum + Number.parseFloat(line.split(' ').pop() ?? '0'), 0);

      const pool = /lab_pg_pool_connections\{state="active"[^}]*\}\s+(\d+)/.exec(metrics);
      const waiting = /lab_pg_pool_connections\{state="waiting"[^}]*\}\s+(\d+)/.exec(metrics);
      replica.pool = pool ? `${pool[1]}a/${waiting?.[1] ?? 0}w` : '—';
    }),
  );

  renderReplicas();
}

async function refresh() {
  const alive = state.replicas.find((r) => r.status !== 'down') ?? state.replicas[0];
  const snapshot = await call(alive.url, '/lab/state');

  if (!snapshot.ok || !snapshot.payload) {
    return;
  }

  if (snapshot.payload.fixture) {
    state.fixture = snapshot.payload.fixture;
  }

  renderTables(snapshot.payload);
  renderInvariants(snapshot.payload.invariantViolations);
  renderLog();
}

async function reset() {
  const result = await call(nextReplica(), '/lab/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCount: 3 }),
  });

  state.fixture = result.payload;
  state.log = [];
  $('result').hidden = true;
  await refresh();
}

function setBusy(busy) {
  state.running = busy;
  document.querySelectorAll('.scenario').forEach((button) => {
    button.disabled = busy;
  });
  $('btn-reset').disabled = busy;
}

async function runScenario(name) {
  if (state.running) return;
  setBusy(true);

  try {
    if (!state.fixture) {
      await reset();
    }
    const result = await scenarios[name]();
    await refresh();
    renderResult(result);
  } catch (error) {
    renderResult({
      title: 'el escenario falló',
      chips: [{ text: 'error', tone: 'bad' }],
      note: String(error),
    });
  } finally {
    setBusy(false);
    await pollReplicas();
  }
}

// ── arranque ────────────────────────────────────────────────────────────────

document.querySelectorAll('.scenario').forEach((button) => {
  button.addEventListener('click', () => void runScenario(button.dataset.scenario));
});

$('btn-reset').addEventListener('click', () => {
  if (state.running) return;
  setBusy(true);
  void reset().finally(() => setBusy(false));
});

renderReplicas();
renderLog();
void pollReplicas();
void refresh();

setInterval(() => {
  if (!state.running) void pollReplicas();
}, 2500);

setInterval(() => {
  if (!state.running) void refresh();
}, 1500);
