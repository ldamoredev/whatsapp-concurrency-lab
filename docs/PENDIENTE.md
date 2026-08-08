# Pendiente — anotado durante los slices 1 y 2

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

## Slice 3 — orden y huecos

- Validar `clientSequence` contra `device_sequences.next_client_sequence` antes de publicar.
  **Hoy no se valida**: el mensaje se publica directo asumiendo que no hay huecos. Esa es la
  diferencia principal entre el estado actual y S3.
- Mensajes `buffered`: llega una secuencia mayor a la esperada → no recibe `server_sequence`
  ni genera deliveries. El schema ya lo soporta (`messages_published_iff_server_sequence`).
- Drenado de contiguos al llegar el que faltaba: con 1,3,4 y luego 2, publicar 2,3,4 en orden.
- Vencimiento del `gap_deadline` → `resync_required`. Necesita worker; el índice parcial
  `device_sequences_gap_deadline_idx` ya está para que el barrido sea barato.
- Contrato explícito de resync: endpoint que devuelve el próximo `client_sequence` esperado.
- **Medir lock vs. optimista.** Hoy el orden se asigna con `SELECT ... FOR UPDATE` sobre
  `conversation_sequences`. La columna `version` existe para poder comparar con un
  compare-and-set con reintento. No elegir sin medir: L1 tiene que decir cuál gana en una
  conversación caliente.

## Slice 4 — multi-device

- `POST /v1/messages/:messageId/acks`.
- UPDATE condicional sobre `delivery_receipts` con `WHERE version = $leido` y avance sólo
  hacia adelante. **Esto es I7 y no lo cubre ningún CHECK** — el schema garantiza que no
  exista un estado incoherente, no que no haya una regresión.
- El incremento de `delivered_count` tiene que estar atado a que el receipt haya cambiado
  realmente de estado, en la misma transacción (I8).
- Cleanup de envelopes: una sola vez, sólo con el batch completo o TTL vencido. Forzar la
  carrera contra el CronJob.
- El estado terminal que habilita cleanup se fija por configuración. Default `delivered`.

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
