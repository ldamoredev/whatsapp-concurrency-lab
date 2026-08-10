/* Utilidades compartidas del panel.
 *
 * Sin framework y sin build step: el proyecto se explica leyendo el código, y una capa
 * de herramientas sería una capa más que explicar. */

/**
 * Cómo llegar a la API, según dónde esté desplegado el laboratorio.
 *
 *   ingress  una sola URL (el mismo origen que sirve esta página). Traefik reparte.
 *   direct   una URL por réplica. No hay balanceador, así que reparte esta página.
 *
 * Se detecta por el puerto: con Docker Compose el panel se sirve desde 3001, 3002 o
 * 3003, que son las réplicas mismas. Detrás del ingress el puerto es cualquier otro.
 */
const COMPOSE_PORTS = ['3001', '3002', '3003'];
export const MODE = COMPOSE_PORTS.includes(location.port) ? 'direct' : 'ingress';

// En modo ingress las URLs son relativas: mismo origen, así que tampoco hace falta
// CORS. En modo direct hay que nombrar las tres réplicas para poder repartir.
export const REPLICAS =
  MODE === 'ingress' ? [''] : COMPOSE_PORTS.map((p) => `http://localhost:${p}`);

export const uuid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * A dónde mandar el próximo request.
 *
 * En modo ingress devuelve siempre la cadena vacía: la URL queda relativa y el reparto
 * lo hace Traefik, como con un cliente real. En modo direct hace round-robin del lado
 * del cliente, que es un sustituto explícito del balanceador que Compose no tiene.
 */
let cursor = 0;
export const nextReplica = () => REPLICAS[cursor++ % REPLICAS.length];

export async function call(url, path, options = {}) {
  const started = performance.now();

  try {
    const response = await fetch(url + path, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* respuestas sin cuerpo */
    }

    const instance = response.headers.get('x-instance-id') ?? '?';
    observeInstance(instance);

    return {
      ok: response.ok,
      status: response.status,
      instance,
      payload,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      instance: '—',
      payload: { code: 'SIN_RED', message: String(error) },
      ms: Math.round(performance.now() - started),
    };
  }
}

/* ── estado del laboratorio ─────────────────────────────────────────────── */

export async function resetLab(deviceCount = 3) {
  const [guarded] = await Promise.all([
    call(nextReplica(), '/lab/reset', { method: 'POST', body: { deviceCount } }),
    call(nextReplica(), '/lab/naive/reset', { method: 'POST' }),
  ]);
  return guarded.payload;
}

export const labState = () => call(REPLICAS[0], '/lab/state').then((r) => r.payload);
export const naiveState = () => call(REPLICAS[0], '/lab/naive/state').then((r) => r.payload);

/* ── barra superior ─────────────────────────────────────────────────────── */

const NAV = [
  ['/', 'portada'],
  ['/idempotencia', 'idempotencia'],
  ['/probar', 'banco de pruebas'],
  ['/orden', 'orden'],
  ['/entrega', 'entrega'],
  ['/infra', 'réplicas'],
];

export function mountTop({ current, depth = true }) {
  const host = $('#top');
  if (!host) return;

  host.innerHTML = `
    <a class="top__brand" href="/">
      <b>whatsapp-concurrency-lab</b>
      <span>lo que impide una constraint, no lo que permite</span>
    </a>
    <nav class="top__nav" aria-label="secciones">
      ${NAV.map(
        ([href, label]) =>
          `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`,
      ).join('')}
    </nav>
    <div class="top__right">
      <span class="mode" title="${
        MODE === 'ingress'
          ? 'una sola URL: el reparto lo hace Traefik'
          : 'una URL por réplica: el reparto lo hace esta página'
      }">${MODE === 'ingress' ? 'ingress' : 'compose'}</span>
      ${
        depth
          ? `<div class="dial" role="group" aria-label="profundidad de lectura">
               <button type="button" data-depth="breve" aria-pressed="false">breve</button>
               <button type="button" data-depth="detallado" aria-pressed="true">detallado</button>
             </div>`
          : ''
      }
      <div class="check" id="check" data-broken="false">
        <span class="check__mark" aria-hidden="true">✓</span>
        <span class="check__text" id="check-text">verificando…</span>
      </div>
    </div>`;

  if (depth) mountDepthDial();
  void pollInvariants();
  setInterval(() => void pollInvariants(), 3000);
}

/**
 * Dial de profundidad: cambia la densidad de la prosa sin mover el esqueleto.
 * Existe porque el panel sirve a dos situaciones — aprender solo y mostrarle a
 * alguien — y una sola densidad falla en una de las dos.
 */
function mountDepthDial() {
  const saved = localStorage.getItem('lab-depth') ?? 'detallado';
  apply(saved);

  $$('.dial button').forEach((button) => {
    button.addEventListener('click', () => apply(button.dataset.depth));
  });

  function apply(depth) {
    document.body.dataset.depth = depth;
    localStorage.setItem('lab-depth', depth);
    $$('.dial button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.depth === depth)),
    );
  }
}

/**
 * La verificación de invariantes corre contra la BASE, no contra respuestas HTTP.
 * Está siempre visible porque un panel que no puede mostrar "cero violaciones" no
 * demuestra nada.
 */
async function pollInvariants() {
  const box = $('#check');
  const text = $('#check-text');
  if (!box || !text) return;

  const state = await labState();
  if (!state) {
    box.dataset.broken = 'false';
    text.textContent = 'sin conexión con la base';
    return;
  }

  const broken = state.invariantViolations ?? [];
  box.dataset.broken = String(broken.length > 0);
  $('.check__mark').textContent = broken.length > 0 ? '✕' : '✓';
  text.textContent =
    broken.length > 0
      ? broken.map((v) => `${v.invariant}: ${v.detail}`).join(' · ')
      : 'I4 · I5 · I8 · I9 sin violaciones';
}

/* ── render ─────────────────────────────────────────────────────────────── */

/**
 * Un solo momento de motion autorizado: el número cuenta hacia arriba al llegar.
 *
 * El valor final se escribe SIEMPRE antes de animar. `requestAnimationFrame` no corre
 * en pestañas de fondo, así que animar desde cero dejaría el número en 0 para siempre
 * si el usuario cambió de pestaña mientras corría el escenario.
 */
export function countTo(node, value, suffix = '') {
  node.textContent = value + suffix;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || value <= 1) return;

  const duration = 480;
  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = Math.round(value * eased) + suffix;
    if (t < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

export function renderVerdict(side, { number, label, chips = [], reading }) {
  const verdict = $('.verdict', side);
  verdict.innerHTML = `
    <div class="verdict__number">0</div>
    <div class="verdict__label">${label}</div>`;
  countTo($('.verdict__number', verdict), number);

  $('.breakdown', side).innerHTML = chips
    .map((c) => `<span class="chip" data-tone="${c.tone ?? 'neutral'}">${c.text}</span>`)
    .join('');

  $('.reading', side).innerHTML = reading ?? '';
}

export function fillTable(box, rows, mapper, emptyText = 'sin datos') {
  const table = $('table', box);
  const tbody = $('tbody', table);
  const columns = $$('thead th', table).length;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr class="empty"><td colspan="${columns}">${emptyText}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const { cells, muted, flag } = mapper(row);
      return `<tr data-muted="${Boolean(muted)}"${flag ? ` data-flag="${flag}"` : ''}>${cells
        .map((c) => `<td>${c}</td>`)
        .join('')}</tr>`;
    })
    .join('');
}

/* ── log ────────────────────────────────────────────────────────────────── */

const logEntries = [];

export function logRequest(label, result, detail) {
  logEntries.unshift({
    instance: result.instance,
    label,
    status: result.status,
    detail: detail ?? describeResult(result),
    ms: result.ms,
  });
  logEntries.length = Math.min(logEntries.length, 120);
  renderLog();
}

export function clearLog() {
  logEntries.length = 0;
  renderLog();
}

function describeResult(result) {
  const p = result.payload ?? {};
  if (p.code) return p.code;
  if (p.messageId) {
    const orden = p.serverSequence == null ? 'sin orden visible' : `server ${p.serverSequence}`;
    return `${orden} · ${String(p.messageId).slice(0, 8)}`;
  }
  if (p.state) return `${p.state}${p.advanced === false ? ' (sin efecto)' : ''}`;
  if (p.deliveredCount !== undefined) return `progreso ${p.deliveredCount}/${p.expectedCount}`;
  return '';
}

function toneOf(status) {
  if (status === 201) return 'ok';
  if (status === 200 || status === 202) return 'replay';
  if (status >= 400 && status < 500) return 'warn';
  return 'bad';
}

function renderLog() {
  const box = $('#log');
  if (!box) return;

  if (logEntries.length === 0) {
    box.innerHTML = '<div class="empty-note">todavía no se disparó nada</div>';
    return;
  }

  box.innerHTML = logEntries
    .map(
      (e) => `
      <div class="log__row">
        <span class="log__instance">${e.instance}</span>
        <span style="color:var(--text-faint)">${e.label}</span>
        <span class="log__status" data-tone="${toneOf(e.status)}">${e.status || '—'}</span>
        <span class="log__detail">${e.detail}</span>
        <span class="log__ms">${e.ms}ms</span>
      </div>`,
    )
    .join('');
}

/* ── réplicas ───────────────────────────────────────────────────────────── */

/**
 * Estado de las réplicas.
 *
 * En modo direct se puede preguntar a cada una por su cuenta. Detrás del ingress NO:
 * hay una sola URL y no hay forma de dirigir un request a un pod concreto. Así que
 * las réplicas se DESCUBREN por el `X-Instance-Id` que trae cada respuesta, y lo que
 * se muestra es cuántas atendió cada una.
 *
 * Es más honesto: es exactamente lo que un cliente real puede observar.
 */
export const replicaState =
  MODE === 'ingress'
    ? []
    : REPLICAS.map((url) => ({
        url,
        instanceId: url.replace('http://localhost:', 'api :'),
        status: 'down',
        posts: 0,
      }));

/** Registra una instancia vista en una respuesta. Sólo se usa en modo ingress. */
function observeInstance(instanceId) {
  if (MODE !== 'ingress' || !instanceId || instanceId === '?' || instanceId === '—') {
    return;
  }

  let replica = replicaState.find((r) => r.instanceId === instanceId);
  if (!replica) {
    replica = { url: '', instanceId, status: 'ready', posts: 0, seen: true };
    replicaState.push(replica);
    replicaState.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }
  replica.posts += 1;
  replica.status = 'ready';
}

export async function pollReplicas() {
  if (MODE === 'ingress') {
    // No se puede sondear pod por pod detrás de un ingress. Un request al ingress
    // alcanza para saber que el servicio responde; el resto lo dice el descubrimiento.
    const health = await call('', '/health/ready');
    if (health.status === 0) {
      replicaState.forEach((r) => { r.status = 'down'; });
    }
    renderReplicas();
    return;
  }

  await Promise.all(
    replicaState.map(async (replica) => {
      const health = await call(replica.url, '/health/ready');

      if (health.status === 0) {
        replica.status = 'down';
        return;
      }

      replica.status = health.payload?.status ?? 'down';
      replica.instanceId = health.payload?.instanceId ?? replica.instanceId;

      const metrics = await fetch(`${replica.url}/metrics`)
        .then((r) => r.text())
        .catch(() => '');

      replica.posts = metrics
        .split('\n')
        .filter((l) => l.startsWith('lab_http_requests_total{method="POST"'))
        .reduce((sum, l) => sum + Number.parseFloat(l.split(' ').pop() ?? '0'), 0);
    }),
  );

  renderReplicas();
}

export function renderReplicas() {
  const host = $('#replicas');
  if (!host) return;

  if (MODE === 'ingress' && replicaState.length === 0) {
    host.innerHTML = `
      <div class="replica">
        <div class="replica__head">
          <span class="dot" data-state="ready"></span>
          <span class="replica__id">detrás del ingress</span>
        </div>
        <div class="replica__row">
          <span>las réplicas aparecen a medida que atienden requests</span>
        </div>
      </div>`;
    return;
  }

  const max = Math.max(1, ...replicaState.map((r) => r.posts));
  const etiqueta = MODE === 'ingress' ? 'respuestas suyas' : 'POST atendidos';

  host.innerHTML = replicaState
    .map(
      (r) => `
      <div class="replica">
        <div class="replica__head">
          <span class="dot" data-state="${r.status}"></span>
          <span class="replica__id">${r.instanceId}</span>
          <span class="replica__state">${r.url ? r.status : 'vista por su X-Instance-Id'}</span>
        </div>
        <div class="replica__row">
          <span class="replica__count">${r.posts}</span>
          <span>${etiqueta}</span>
        </div>
        <div class="bar"><div class="bar__fill" style="transform:scaleX(${(r.posts / max).toFixed(3)})"></div></div>
      </div>`,
    )
    .join('');
}

export function setBusy(busy) {
  $$('.run__btn').forEach((b) => {
    b.disabled = busy;
    b.dataset.label ??= b.textContent;
    b.textContent = busy ? 'corriendo…' : b.dataset.label;
  });
}
