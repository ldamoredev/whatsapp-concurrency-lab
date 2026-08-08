# Pendiente — anotado durante el slice 1

Cosas que aparecieron mientras se escribía el schema y que **no** entran hoy. Se anotan acá
para no perderlas y para no meterlas antes de tiempo.

## Slice 2 — envío idempotente

- `POST /v1/conversations/:conversationId/messages` con header `Idempotency-Key`.
- Cálculo del fingerprint canónico. Es un unit test, no necesita base.
- Traducción de `23505` sobre `idempotency_operations_actor_route_key_uniq` a la respuesta
  correcta: replay, `409 IDEMPOTENCY_KEY_REUSED` o `409 IDEMPOTENCY_IN_PROGRESS` según el
  fingerprint y el status de la operación que ya existe.
- Lease + `attempt`: el UPDATE final tiene que llevar `WHERE attempt = $leido`. Sin eso el
  fencing no existe, aunque la columna esté.
- Decidir y **documentar** si los cuatro recovery points se colapsan en una sola transacción
  corta. Si se colapsan, el README de implementación debe explicar por qué no queda una
  ventana ambigua interna. La columna `recovery_point` ya soporta las dos opciones.
- `expires_at` de las operaciones necesita un cleanup; hoy sólo existe el índice.

## Slice 3 — orden y huecos

- Asignación de `server_sequence` tomando `conversation_sequences FOR UPDATE`. El test de
  bloqueo ya está escrito en `sequences.constraints.spec.ts` y muestra el lock funcionando.
- Alternativa a medir: compare-and-set optimista sobre `version` con reintento, en vez del
  lock pesimista. La columna `version` existe para poder comparar las dos. **No elegir sin
  medir.**
- Drenado de mensajes contiguos bufferizados al llegar el que faltaba.
- Vencimiento del `gap_deadline` → `resync_required`. Necesita un worker; el índice parcial
  `device_sequences_gap_deadline_idx` ya está para que ese barrido sea barato.
- Contrato explícito de resync: endpoint que devuelve el próximo `client_sequence` esperado.

## Slice 4 — multi-device

- UPDATE condicional sobre `delivery_receipts` con `WHERE version = $leido` y avance sólo
  hacia adelante. **Esto es I7 y no lo cubre ningún CHECK** — el schema garantiza que no
  exista un estado incoherente, no que no haya una regresión.
- El incremento de `delivered_count` tiene que estar atado a que el receipt haya cambiado
  realmente de estado, en la misma transacción. Si no, I8 se rompe y el CHECK
  `delivery_batches_delivered_not_above_expected` va a avisarlo tarde y ruidosamente (que es
  mejor que no avisar, pero no es la solución).
- Cleanup de envelopes: una sola vez, sólo con el batch completo o TTL vencido. Forzar la
  carrera contra el CronJob.
- El estado terminal que habilita cleanup se fija por configuración. Default `delivered`;
  `read` sigue siendo recibo de producto, no requisito para liberar trabajo.

## Slices posteriores

- Docker multi-stage no-root, k3d multi-node, Traefik, 3 pods, PDB, probes, spread.
- Toxiproxy entre API y Postgres, k6 desde fuera del cluster.
- Prometheus + Grafana. Nunca IDs ni keys como labels.
- `evidence/RESULTS.md`.

## Deudas concretas del slice 1

- `conversation_devices.removed_at` existe pero nada lo usa todavía. Cuando el slice 4 lo
  use, decidir si la membresía baja se excluye del snapshot (probablemente sí) y dejarlo
  escrito.
- `messages.body` es `text` sin límite. Antes de la carga hay que fijar un tamaño máximo, o
  el workload de k6 va a medir el ancho de banda del disco en vez de la concurrencia.
- No hay índice sobre `messages(conversation_id, sender_device_id)` para el borrado en
  cascada de `conversation_devices`. Hoy no se borran membresías; cuando se borren, medir.
- El pool está fijo en 10 conexiones. El número correcto sale de L1/L3, no de una intuición.
