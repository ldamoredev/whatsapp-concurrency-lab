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

## ~~S5 — contenedor, salud y métricas~~ ✅ hecho

Cerrado el 9 de agosto de 2026. Quedó afuera y sigue pendiente:

- **No hay balanceador.** Las tres réplicas exponen puertos distintos y el round-robin lo
  hace el cliente. Traefik llega con k3d; hasta entonces no se puede afirmar nada sobre
  reparto real ni sobre ausencia de sticky sessions.
- **`readOnlyRootFilesystem`** no se puede probar con Compose. Va en el `securityContext`
  del Deployment, con un `emptyDir` en `/tmp`.
- **Las métricas de negocio están definidas pero no se incrementan todavía.**
  `lab_idempotency_outcomes_total`, `lab_ack_transitions_total` y compañía existen en el
  registry; falta llamarlas desde los servicios. Se hace junto con el panel, que las
  consume.
- **No hay logs JSON estructurados** con `requestId`, `operationId`, `messageId` e
  `instanceId`. Hoy sólo hay un `console.error` en el filtro de errores.

## ~~S6 — el panel~~ ✅ hecho

Cerrado el 9 de agosto de 2026. Quedó afuera y sigue pendiente:

- **Las réplicas están hardcodeadas** en `public/panel.js` (`:3001`, `:3002`, `:3003`).
  Cuando llegue Traefik el panel apunta a una sola URL y la lista desaparece; mientras
  tanto, cambiar de puertos exige tocar el archivo.
- **`/lab/expire-gaps?force=true`** adelanta los deadlines para no esperar el
  `gapTimeoutMs` real. No cambia la lógica del barrido, pero es una comodidad del panel
  que no debería existir fuera del lab.
- **El panel no muestra las métricas de negocio** que ahora sí se incrementan
  (`lab_idempotency_outcomes_total`, `lab_ack_transitions_total`). Las lee sólo para el
  contador de POST por réplica. Cuando esté Grafana, ahí van.
- **Sin gráficos de series temporales**: el panel muestra el estado actual, no la
  evolución. Eso es trabajo de Grafana, no del panel.

## ~~S7 — Kubernetes~~ ✅ parcial (9 de agosto de 2026)

**Verde y verificado ejecutando:** k3d multi-node (1 server + 2 agents), imagen importada a
los tres nodos, PostgreSQL en `StatefulSet` con PVC, `Job` de migraciones separado del
arranque, `Deployment` ×3 no-root con las tres probes y resources, `Service` ClusterIP,
`ConfigMap`/`Secret`, e **Ingress de Traefik**.

La prueba no fue `/health` en 200: fueron 12 requests con la misma `Idempotency-Key`
**desde fuera del cluster**, entrando por el ingress → reparto **4/4/4** entre los tres
pods, 1 creado, 11 replays, **1 mensaje** en la base. El panel también entra por el ingress
y descubre las réplicas por su `X-Instance-Id`.

**Falta:**

- **PodDisruptionBudget** `minAvailable: 2` y **topology spread / anti-affinity**. Hoy los
  pods quedan en nodos distintos por decisión del scheduler, no por una regla.
- **NetworkPolicy**: falta comprobar si flannel (el CNI de k3d) la implementa. Si no,
  documentar el límite en vez de fingir que está.
- **Los dos `CronJob`** (`gaps:expire` y `deliveries:cleanup`). Los scripts existen y son el
  cuerpo exacto; falta el manifest.
- **Postgres sigue con una sola réplica**, a propósito: prueba consistencia de aplicación y
  recuperación de pods, **no** alta disponibilidad de la base.

### Tres cosas que costaron tiempo y conviene no repetir

- **`kubectl port-forward svc/…` NO balancea.** Fija un pod y se queda ahí, aunque apuntes al
  Service: doce curl dieron los doce al mismo pod. Por eso hay dos smoke tests —
  `k8s:smoke` corre **dentro** del cluster y `k8s:smoke:ingress` **desde el host**.
- **La sustitución `$(VAR)` de Kubernetes sólo resuelve variables declaradas ANTES** en la
  misma lista `env`. Con `DATABASE_URL` primero, el contenedor recibió el literal
  `$(POSTGRES_USER)` y el Job falló sin decir por qué. El orden de `env:` es significativo.
- **Un Ingress sin puerto publicado es inalcanzable.** El `serverlb` de k3d sólo expone 6443;
  hizo falta `ports: 8081:80` con `nodeFilter: loadbalancer` en `infra/k3d/cluster.yaml`, y
  cambiar eso obliga a **recrear el cluster**.

### El test C1 es sensible a la saturación de la máquina

`100 envios concurrentes con la misma key` falló **una vez**, con el cluster k3d y Docker
Compose corriendo a la vez. Cuatro corridas posteriores de la suite completa en verde, y el
caso aislado diez veces también.

Causa probable: 100 requests concurrentes contra un pool de 10 con
`connectionTimeoutMillis: 5000`. Con la máquina saturada algunos dan timeout **de
conexión**, y la aserción `created + replayed + inProgress === 100` no distingue ese timeout
de una violación de invariante.

**No se tocó el test**: subir el timeout o aflojar la aserción sería maquillar. Lo correcto
es que distinga «el sistema violó una invariante» de «la máquina no daba abasto», lo que
pide clasificar el error de pool aparte. Hasta entonces: correr la suite con un solo stack
levantado.

### Deuda del entorno

- **kubectl local es v1.24 (2022).** Por eso el cluster está fijado a `rancher/k3s:v1.25.16`
  en `infra/k3d/cluster.yaml`: el skew soportado es ±1 minor. Al actualizar kubectl, subir
  ese pin.
- **Docker Compose 2.5.1 no arranca los contenedores con `up -d --force-recreate`**: los deja
  en `created` y hay que hacer `docker compose start`.

## S8 — fallos, carga y evidencia

- Toxiproxy entre API y Postgres, k6 desde fuera del cluster.
- Prometheus + Grafana como código. Nunca IDs ni keys como labels.
- Pod kill durante carga (I11), `evidence/RESULTS.md`.

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
