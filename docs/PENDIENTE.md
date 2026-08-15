# Pendiente — anotado durante los cuatro slices de dominio

Cosas que aparecieron mientras se escribía y que **no** entran todavía. Se anotan acá para
no perderlas y para no meterlas antes de tiempo.

## ~~Slice 2 — envío idempotente~~ ✅ hecho

Cerrado el 8 de agosto de 2026. Ver [ADR 0001](adr/0001-una-transaccion-para-el-efecto.md).
Quedó afuera del slice y sigue pendiente:

- **Cleanup de operaciones expiradas.** `idempotency_operations.expires_at` se escribe y hay
  índice, pero **nada barre las vencidas, y esto sigue abierto**. Ojo con el malentendido
  fácil: los dos CronJobs de S7 barren *huecos* y *batches de entrega*; ninguno toca
  `idempotency_operations`. Falta el script —no existe— antes que el manifest.
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

- ~~**El barrido de huecos no corre solo.**~~ ✅ Resuelto el 15 de agosto: el CronJob
  `gaps-expire` corre cada minuto. Ver S7.
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

- ~~**Ni el cleanup ni el barrido de huecos corren solos.**~~ ✅ Resuelto el 15 de agosto:
  los dos CronJobs están puestos y verificados ejecutando. Ver S7. El cleanup por batch
  completo ya ocurría solo con el último ack; lo que faltaba —el barrido por TTL— ahora lo
  hace `deliveries-cleanup` cada cinco minutos.
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

## ~~S7 — Kubernetes~~ ✅ hecho (15 de agosto de 2026)

**Verde y verificado ejecutando:** k3d multi-node (1 server + 2 agents), imagen importada a
los tres nodos, PostgreSQL en `StatefulSet` con PVC, `Job` de migraciones separado del
arranque, `Deployment` ×3 no-root con las tres probes y resources, `Service` ClusterIP,
`ConfigMap`/`Secret`, e **Ingress de Traefik**.

La prueba no fue `/health` en 200: fueron 12 requests con la misma `Idempotency-Key`
**desde fuera del cluster**, entrando por el ingress → reparto **4/4/4** entre los tres
pods, 1 creado, 11 replays, **1 mensaje** en la base. El panel también entra por el ingress
y descubre las réplicas por su `X-Instance-Id`.

**Cerrado el 15 de agosto**, también ejecutando y no declarando:

- **Los dos `CronJob`** (`infra/k8s/base/50-cronjobs.yaml`). `gaps-expire` cada minuto,
  `deliveries-cleanup` cada cinco. No se reescribió nada: los dos invocan el artefacto
  compilado que ya viajaba en la imagen (`dist/scripts/`), la misma imagen que la API.
  - `gaps-expire` se dejó correr **por su propio horario**. Un stream con hueco quedó en
    `waiting_gap` con deadline 21:16:18; la corrida de 21:16:00 —anterior al hueco— dijo
    "Sin huecos vencidos", y la de 21:17:00 lo barrió. En la base: antes `waiting_gap` con
    deadline, después `resync_required` con deadline `NULL`.
  - `deliveries-cleanup` con un `Job` disparado desde el CronJob, camino TTL: batch con 3
    envelopes sin completar → `cleanup_reason=expired`, envelopes 0, **receipts 3**, que
    sobreviven a propósito porque son con lo que se verifica I9.
- **PodDisruptionBudget** `minAvailable: 2`, probado con la API de evicción (la que usa
  `kubectl drain`): primera evicción `201`, segunda inmediata `429 Cannot evict pod as it
  would violate the pod's disruption budget`, presupuesto de 1 → 0.
- **Topology spread** `maxSkew: 1` con `DoNotSchedule`: una réplica por nodo por **regla**,
  no por decisión del scheduler. Ver la trampa de `maxSurge` más abajo.
- **NetworkPolicy**: **sí se aplica**, al revés de lo que se sospechaba. Ver abajo.
- **Postgres sigue con una sola réplica**, a propósito: prueba consistencia de aplicación y
  recuperación de pods, **no** alta disponibilidad de la base.

### Seis cosas que costaron tiempo y conviene no repetir

- **`kubectl port-forward svc/…` NO balancea.** Fija un pod y se queda ahí, aunque apuntes al
  Service: doce curl dieron los doce al mismo pod. Por eso hay dos smoke tests —
  `k8s:smoke` corre **dentro** del cluster y `k8s:smoke:ingress` **desde el host**.
- **La sustitución `$(VAR)` de Kubernetes sólo resuelve variables declaradas ANTES** en la
  misma lista `env`. Con `DATABASE_URL` primero, el contenedor recibió el literal
  `$(POSTGRES_USER)` y el Job falló sin decir por qué. El orden de `env:` es significativo.
- **Un Ingress sin puerto publicado es inalcanzable.** El `serverlb` de k3d sólo expone 6443;
  hizo falta `ports: 8081:80` con `nodeFilter: loadbalancer` en `infra/k3d/cluster.yaml`, y
  cambiar eso obliga a **recrear el cluster**.
- **El topology spread se evalúa al PLANIFICAR, y `maxSurge` lo arruina en silencio.** El
  primer rollout con la regla puesta dejó **0 pods en `server-0` y 2 en `agent-1`**, con la
  regla aplicada y sin ningún error. Con `maxSurge: 25%` el pod nuevo se crea mientras el
  viejo todavía existe y el viejo **sigue contando para el skew de su nodo**: cada colocación
  era legal por separado y el resultado final igual violaba la regla. Por eso el Deployment
  fija `maxSurge: 0` / `maxUnavailable: 1`. Kubernetes tampoco reubica nada después: si se
  agrega un nodo, los pods se quedan donde están hasta que algo los recree. Verificar el
  reparto **después de un `rollout restart` completo**, no recién desplegado.
- **Flannel no implementa NetworkPolicy, pero k3s sí — la sospecha del handoff era al revés.**
  k3s trae su propio controlador (kube-router) encendido salvo `--disable-network-policy`, y
  se aplica de verdad. Medido con dos pods idénticos que esperan 30 s antes de conectar (para
  que el resultado no sea el retraso de propagación de las reglas): etiqueta no autorizada
  **BLOQUEADO (`ECONNREFUSED`)**, etiqueta `app=gaps-expire` **CONECTO**. Antes de aplicar la
  política, el mismo pod conectaba. Dos cosas que confunden al diagnosticar:
  - el rechazo llega como **`ECONNREFUSED`**, no como timeout: parece un error *de Postgres*
    y no de la red. Si un workload nuevo no puede hablar con la base, mirar primero si su pod
    matchea algún selector de `60-networkpolicy.yaml`.
  - un pod recién creado puede ser rechazado durante los primeros segundos aunque **esté**
    autorizado, hasta que kube-router programa su IP. Con los CronJob no pasó (tres corridas
    seguidas `Complete` sin fallos), pero al probar a mano hay que esperar antes de concluir.
- **`restartCount: 1` en un pod de Job no significa que falló.** Los pods de los CronJob
  aparecían como `Completed 1` justo después de aplicar la NetworkPolicy y parecía que cada
  corrida pagaba un intento fallido. No: `lastState` vacío, un solo evento `Started`, ningún
  `BackOff`, y el Job con `succeeded: 1` / `failed: none`. La verdad está en las condiciones
  del **Job**, no en el contador de reinicios del pod.

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

Nota de la máquina nueva (15 de agosto): C1 no volvió a fallar en ninguna de las cuatro
corridas completas de la suite, con Compose bajado antes de levantar k3d. **Pero acá hay
además 8 contenedores de otros proyectos corriendo** (redpanda, jaeger, 4 Postgres) que no
se tocaron por no ser de este repo. Son exactamente el tipo de carga de fondo que este flake
mide: si vuelve a aparecer, mirar `docker ps` completo antes de sospechar del código.

### Deuda del entorno

**El repo se usa desde dos máquinas y no tienen el mismo toolchain.** Lo que sigue es por
máquina, porque mezclarlo ya causó un pin mal justificado.

- **El pin de k3s es uno solo para las dos máquinas, y hoy es `rancher/k3s:v1.30.14-k3s1`.**
  Se subió desde `v1.25.16-k3s4` el 15 de agosto, cuando el repo se clonó en una máquina con
  **kubectl v1.30.2**: contra 1.25 el skew era de 5 minors, muy fuera de la política de ±1.
  El comentario de `infra/k3d/cluster.yaml` decía "el kubectl de esta máquina es 1.24" y ya
  no era cierto de nadie; está reescrito.

  **Para la máquina vieja (kubectl 1.24):** un cluster ya creado **no cambia solo** —sigue
  corriendo la imagen con la que nació—, así que traer estos commits no rompe nada de
  inmediato. Pero el primer `cluster:up` después de un `cluster:down` lo recrea con 1.30, y
  kubectl 1.24 no puede hablarle. **Subir kubectl allá antes de recrear el cluster.**
- **`npm ci` en limpio: 148 paquetes, sin sorpresas.** `npm audit` reporta 2 vulnerabilidades
  high; no se tocó (`audit fix` mueve dependencias y eso no era el alcance).
- **k3d se instala con `brew install k3d`** (acá quedó 5.9.0). **helm y k6 siguen sin
  instalar**: helm no hace falta hoy, k6 sí para S8.
- **Docker Compose 2.5.1 no arranca los contenedores con `up -d --force-recreate`**: los deja
  en `created` y hay que hacer `docker compose start`. En la máquina nueva (Compose 2.29.7)
  esto **no** pasa: `db:up` con `--wait` funcionó de una.

### El fixture de lease de 1 ms dependía de la velocidad de la máquina

Al clonar en la máquina nueva, 2 de 175 tests salieron en rojo —de forma **intermitente**:
cinco corridas dieron 2, 1, 2, 2, 2 fallos—. Los dos eran de `lease y fencing`.

No era el dominio. Tres fixtures pedían `leaseMs: 1` y daban por hecho que el statement
siguiente llegaría más de un milisegundo después. Eso es una carrera contra la latencia:
medido acá, el round-trip va de **0.47 a 3.08 ms**, con 4 de 15 por debajo del milisegundo.
Reproduciendo el camino exacto, el margen de `lease_until - now()` al leer iba de -5.9 ms a
**-0.45 ms**: cruza el cero. Cuando la máquina gana, el lease **todavía está vivo** al
mirarlo y `lease_is_alive` vuelve `true`.

Se cambió a `LEASE_YA_VENCIDO_MS = -1000` (`lease_until = now() - 1s`). **Esto no contradice
la regla de no maquillar tests**, y la diferencia con el flake de C1 importa: en C1 aflojar la
aserción escondería la distinción entre "el sistema violó una invariante" y "la máquina no
daba abasto". Acá pasa lo contrario — el test no distinguía "el lease venció" de "la máquina
fue rápida", y fijar el deadline en el pasado lo vuelve **más estricto**, no más laxo. No se
tocó `src/`: la comparación siempre la hizo PostgreSQL, que es el punto del test.

## S8 — fallos, carga y evidencia

**Lo primero, porque bloquea todo lo demás: el seed reproducible.** Sin datos conocidos no
hay corrida de k6 repetible, y sin corrida repetible el pod kill bajo carga no prueba nada —
mide dos poblaciones distintas y la diferencia no se puede atribuir a la falla. Hoy lo único
que arma estado es `POST /lab/reset` (una conversación, hasta 8 dispositivos, y **trunca
todas las tablas**), y la demo del README crea la conversación con SQL a mano. Falta un
script idempotente y parametrizable: N conversaciones × M dispositivos, corrible contra
Compose y contra el cluster, que se pueda correr dos veces sin duplicar nada. **No empezado.**

- Toxiproxy entre API y Postgres, k6 desde fuera del cluster (**k6 no está instalado**).
- El escenario base de k6 va contra el **ingress**, no contra los pods, y con modelo abierto.
  Falta anotar el primer p95.
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
  administración** (crear conversación, agregar dispositivo). Para k6 hace falta un seed
  script reproducible: es lo que abre S8 y está descrito arriba.
