# Pendiente — anotado durante los cuatro slices de dominio

Cosas que aparecieron mientras se escribía y que **no** entran todavía. Se anotan acá para
no perderlas y para no meterlas antes de tiempo.

## ~~Slice 2 — envío idempotente~~ ✅ hecho

Cerrado el 8 de agosto de 2026. Ver [ADR 0001](adr/0001-una-transaccion-para-el-efecto.md).
Quedó afuera del slice y sigue pendiente:

- **Cleanup de operaciones expiradas.** `idempotency_operations.expires_at` se escribe y hay
  índice, pero nada barre las vencidas. Va como CronJob junto con el cleanup de envelopes.
- **Failpoint HTTP real para C2.** Hoy C2 se prueba a nivel de servicio: se ejecuta, se
  descarta el resultado y se reintenta. Falta la versión que corta el socket **después del
  commit** y reintenta contra el ingress. Necesita el cluster; un `500` antes del commit no
  sirve para simular esto.
- **`IdempotencyLeaseLostError` devuelve 409.** Es defendible (el cliente reintenta y
  encuentra el resultado del owner nuevo) pero quizás `503 + Retry-After` describa mejor
  "esto fue transitorio y no fue tu culpa". Decidir con datos de L1, no por intuición.

## ~~Slice 3 — orden y huecos~~ ✅ hecho

Cerrado el 8 de agosto de 2026. Ver
[ADR 0002](adr/0002-orden-antes-que-disponibilidad.md). Quedó afuera y sigue pendiente:

- **El barrido de huecos no corre solo.** `npm run gaps:expire` existe y es el cuerpo exacto
  del futuro CronJob, pero hoy hay que invocarlo a mano. Sin él, un stream con un hueco
  queda en `waiting_gap` para siempre.
- **Medir lock vs. optimista.** El orden se asigna con `SELECT ... FOR UPDATE` sobre
  `conversation_sequences`. La columna `version` existe para poder comparar con un
  compare-and-set con reintento. No elegir sin medir: L1 tiene que decir cuál gana en una
  conversación caliente.
- **El drenado en cascada publica de a uno** dentro de la transacción que tiene tomado el
  lock del contador de la conversación. Con cientos de mensajes bufferizados esa transacción
  se estira y bloquea al resto de la conversación. Medir en L1 antes de optimizar.
- **`gapTimeoutMs` es un número inventado** (30 s por defecto). El valor correcto sale de
  medir cuántos `resync_required` produce en la práctica.
- Falta métrica de gaps activos y su edad, y de transiciones a `resync_required`.

## ~~Slice 4 — multi-device~~ ✅ hecho

Cerrado el 9 de agosto de 2026. Ver
[ADR 0003](adr/0003-cleanup-con-razon-declarada.md). Quedó afuera y sigue pendiente:

- **Ni el cleanup ni el barrido de huecos corren solos.** `npm run deliveries:cleanup` y
  `npm run gaps:expire` son los cuerpos exactos de los futuros CronJobs, pero hoy hay que
  invocarlos a mano. El cleanup por batch completo sí ocurre solo, disparado por el último
  ack; el que falta es el barrido por TTL.
- **No hay endpoint para listar los receipts de un mensaje.** Hoy se consulta de a uno por
  dispositivo. Para un cliente real haría falta el listado.
- **`DELIVERY_TERMINAL_STATE` cambia el comportamiento en caliente.** Si se cambia de
  `delivered` a `read` con batches en vuelo, los que ya contaron progreso con el umbral
  viejo no se recalculan. Hoy no importa (es un lab), pero hay que decirlo antes de que
  alguien lo toque en una corrida larga.

## Slices posteriores

- Health `startup`/`readiness`/`liveness` y `/metrics`. **No existen todavía.**
- Docker multi-stage no-root, k3d multi-node, Traefik, 3 pods, PDB, probes, spread.
- Toxiproxy entre API y Postgres, k6 desde fuera del cluster.
- Prometheus + Grafana. Nunca IDs ni keys como labels.
- Logs JSON estructurados con `requestId`, `operationId`, `messageId`, `instanceId`. Hoy sólo
  hay un `console.error` en el filtro de errores.
- `evidence/RESULTS.md`.

## Deudas concretas abiertas

- **El pool está fijo en 10 conexiones** y C1 lanza 100 requests concurrentes contra él. Hoy
  pasa, pero el número correcto sale de L1/L3, no de una intuición.
- **Ningún reloj de la aplicación decide nada, y hay que mantenerlo así.** Un bug del slice 3
  comparaba `lease_until` (escrito por Postgres) contra `new Date()` de Node; se manifestó
  como un test intermitente. Toda comparación temporal va en SQL. Hay un test de regresión
  (`la vigencia del lease la decide PostgreSQL`), pero no hay nada que lo impida
  automáticamente en código nuevo.
- `conversation_devices.removed_at` ya se usa para excluir bajas del snapshot
  (`snapshotRecipients`), pero **nada lo escribe**: no hay endpoint para dar de baja un
  dispositivo. Cuando lo haya, decidir qué pasa con los batches ya congelados (probablemente
  nada, que es el punto).
- No hay índice sobre `messages(conversation_id, sender_device_id)` para el borrado en
  cascada de `conversation_devices`. Hoy no se borran membresías; cuando se borren, medir.
- `delivery_envelopes` no se consume: nadie los procesa ni los marca `delivered`. Es trabajo
  pendiente que hoy sólo se acumula. Slice 4.
- La demo del README crea la conversación con SQL a mano porque **no hay endpoints de
  administración** (crear conversación, agregar dispositivo). Para k6 va a hacer falta un
  seed script reproducible.
