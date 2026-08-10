# whatsapp-concurrency-lab

Laboratorio backend de **idempotencia, orden por conversación y concurrencia
multi-dispositivo sobre estado compartido**. No es un clon de WhatsApp: el chat es sólo el
vocabulario con el que se hacen visibles esas carreras.

El alcance completo del proyecto está en [`docs/ALCANCE.md`](docs/ALCANCE.md). Ese archivo
manda y no se edita desde acá.

## Estado: dominio completo + contenedor, salud, métricas y panel

Lo que existe hoy:

- Node LTS + TypeScript + NestJS con Fastify, PostgreSQL 16 en Docker Compose.
- Migraciones SQL versionadas con las 10 tablas del modelo mínimo y sus constraints.
- **Envío idempotente**: lease + fencing por `attempt`, respuesta reproducible, replay.
- **Orden por conversación con política de huecos**: los adelantados quedan `buffered` sin
  orden visible ni deliveries; al llegar el que falta se publican en cascada. Un hueco
  vencido bloquea el stream y exige un resync explícito del cliente.
- **Entrega multi-dispositivo**: acks monotónicos e idempotentes, progreso atado al cambio
  real de estado, y cleanup de envelopes que ocurre una sola vez — con la razón declarada.
- **Imagen Docker multi-stage no-root**, tres réplicas de la API con Docker Compose y un
  Job de migraciones separado del arranque.
- **Salud, identidad y métricas**: las tres probes con responsabilidades distintas,
  `X-Instance-Id` en cada respuesta, `/metrics` en formato Prometheus y apagado ordenado
  probado (no-ready → drenar → cerrar pool).
- **Panel de laboratorio** servido por la propia API: qué réplica atendió cada request,
  botones que disparan las carreras de verdad contra las tres réplicas, y el estado de la
  base en vivo con la verificación de invariantes siempre a la vista.
- **171 tests**: unit, integración contra PostgreSQL real y e2e HTTP, incluidos C1 (100
  requests concurrentes), C2 (respuesta perdida post-commit), C3 (1, 3, 4 → 2 y el hueco
  que vence) y C4 (acks duplicados, fuera de orden y concurrentes con el CronJob).

Lo que **no** existe todavía: Kubernetes, k6, Toxiproxy y Grafana.
Ver [`docs/PENDIENTE.md`](docs/PENDIENTE.md).

## El panel

```bash
npm run stack:up
```

Y abrir **http://localhost:3001**.

Cada escenario **corre dos veces**, con la misma entrada y contra la misma base: primero por
el camino ingenuo —el que uno escribe cuando todavía no pensó en concurrencia— y después por
el camino real. Los requests salen del navegador hacia las tres réplicas; si los orquestara
el servidor, todo pasaría por un proceso y no habría carrera que mostrar.

| Página | La pregunta | Sin protección | Con protección |
|---|---|---|---|
| **/probar** | ¿qué valores viajan y cuál de las dos reglas actuó? | un request por vez, editable | — |
| **/idempotencia** | el cliente reintenta, ¿cómo sabe el servidor que es el mismo pedido? | 2 a 15 mensajes | exactamente 1 |
| **/orden** | los mensajes llegan desordenados, ¿se publican como llegan? | `1 · 3 · 4 · 2` | `1 · 2 · 3 · 4` |
| **/entrega** | tres dispositivos confirman con reintentos, ¿cómo se cuenta? | progreso 21 de 3 | 3 de 3 |
| **/infra** | el estado completo, sin narración | — | — |

Corridas reales, verificadas en navegador:

```text
idempotencia   sin protección  6      con protección  1
orden          sin protección  1·3·4·2    con protección  1·2·3·4
entrega        sin protección  21/3   con protección  3/3
```

El número del lado ingenuo **cambia en cada corrida**: a veces 2, a veces 15, a veces
ninguno. Eso es lo que hace peligrosa a una condición de carrera — no falla siempre, falla
*a veces*, y en desarrollo casi nunca. El panel lo dice explícitamente.

Arriba a la derecha, la verificación de invariantes corre **contra la base** (I4, I5, I8, I9)
y tiene que decir siempre *sin violaciones*. Contar respuestas 2xx no demostraría nada.

El dial **breve / detallado** cambia la densidad de la prosa sin mover el esqueleto: el panel
sirve para aprenderlo solo y para mostrárselo a alguien, y una sola densidad falla en una de
las dos.

### El banco de pruebas

`/probar` manda **un request por vez** y deja tocar cada campo: la key, el texto, el
`clientSequence`, el `senderId`. Muestra el request tal como sale por la red, el
`fingerprint` que el servidor calcula —con la misma función que usa el envío real, no una
copia— y **por qué decidió lo que decidió**: si actuó la key o el fingerprint, y si creó algo
o no.

Es la respuesta a la pregunta que el resto del panel da por sabida: **el servidor no adivina
si estás reintentando; se lo decís vos repitiendo la key**. La key responde *"¿es el mismo
intento?"* y la decide el cliente; el fingerprint responde *"¿el cliente está usando bien esa
etiqueta?"* y lo verifica el servidor.

> El camino sin protección corre contra **tablas espejo sin constraints**
> (`migrations/0006`), nunca contra las reales: así la demostración no deja el sistema
> desprotegido mientras corre. `POST /lab/reset` trunca la base — es la funcionalidad, no un
> riesgo. Todo se apaga con `LAB_PANEL_ENABLED=false`.

El diseño del panel está registrado en [`DESIGN.md`](DESIGN.md) y el contexto de producto en
[`PRODUCT.md`](PRODUCT.md).

## Tres réplicas en un comando

```bash
npm run stack:up
```

Levanta PostgreSQL, corre las migraciones como job separado y arranca **tres réplicas** de
la API en `:3001`, `:3002` y `:3003`. Después:

```bash
npm run demo:replicas
```

Manda las mismas carreras contra los tres procesos. Salida real de una corrida:

```text
→ api-1  201 creado   messageId c798530e
→ api-2  200 replay   messageId c798530e
→ api-3  200 replay   messageId c798530e

90 requests concurrentes → 201 creado: 1 · 200 replay: 60 · 409 en curso: 29
reparto:  api-1 ██ 30   api-2 ██ 30   api-3 ██ 30
base:     mensajes 2   batches 2   envelopes 6
```

Tres procesos con memorias separadas, una sola autoridad: PostgreSQL. Es el punto entero
del laboratorio.

> **Nota honesta:** no hay balanceador todavía — el alcance prohíbe agregar Nginx y Traefik
> llega con k3d. Cada réplica expone su puerto y el round-robin lo hace el cliente. Es un
> sustituto explícito y temporal.

## Salud y métricas

| Probe | Qué contesta | Toca la base |
|---|---|---|
| `GET /health/startup` | ¿terminó de arrancar? | **sí**, una vez |
| `GET /health/live` | ¿el proceso puede progresar? | **no** |
| `GET /health/ready` | ¿puedo aceptar trabajo ahora? | **no** |

Que `live` y `ready` **no** consulten Postgres es deliberado: durante una degradación
compartida, un liveness que la chequeara haría que Kubernetes reinicie las tres réplicas a
la vez por un problema que ningún reinicio arregla.

`GET /metrics` expone formato Prometheus con `instance` como label. **Ningún ID va como
label** — la ruta se reporta con parámetros (`/v1/messages/:messageId`), nunca la URL
concreta, o cada UUID crearía una serie temporal nueva.

## La API

### `POST /v1/conversations/:conversationId/messages`

Header obligatorio `Idempotency-Key`. Body:

```json
{
  "senderId": "uuid",
  "senderDeviceId": "uuid",
  "clientMessageId": "local-1",
  "clientSequence": 1,
  "body": "hola"
}
```

| Situación | Respuesta |
|---|---|
| primera ejecución, y es el `clientSequence` esperado | `201` + el mensaje publicado |
| llegó adelantado: falta uno anterior | `202` + el mensaje `buffered`, sin orden visible |
| misma key, mismo pedido, ya completado | `200` + **el mismo** `messageId` (I3) |
| misma key, otro pedido | `409 IDEMPOTENCY_KEY_REUSED`, sin ejecutar nada (I2) |
| misma key, mismo pedido, en curso | `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After` |
| esa posición del stream está tomada por otro mensaje | `409 CLIENT_SEQUENCE_CONFLICT` (I4) |
| el hueco venció y el stream está bloqueado | `409 STREAM_RESYNC_REQUIRED` + `nextClientSequence` |
| conversación inexistente o dispositivo no miembro | `404 SENDER_NOT_IN_CONVERSATION` |

Cuando llega el mensaje que faltaba, la respuesta trae `drained`: cuántos mensajes
bufferizados se publicaron en cascada junto con él.

La respuesta lleva `X-Idempotent-Replay: true|false` — sólo para el laboratorio, para poder
ver por qué camino salió.

### `GET|POST /v1/conversations/:id/devices/:id/stream`

El contrato explícito de resincronización. `GET` devuelve el próximo `clientSequence`
esperado, el estado del stream (`ok` · `waiting_gap` · `resync_required`) y el deadline del
hueco. `POST .../stream/resync` con `{ "fromClientSequence": N }` es la **única** forma de
saltar un hueco, y la decide el cliente — nunca el servidor. Ver
[ADR 0002](docs/adr/0002-orden-antes-que-disponibilidad.md).

### `POST /v1/messages/:messageId/acks`

Body `{ "deviceId": "uuid", "state": "delivered" | "read" }`. **No lleva
`Idempotency-Key` y no la necesita**: el estado del recibo *es* la clave. El mismo ack
repetido veinte veces mueve el recibo una sola vez, porque la condición de avance vive en el
`WHERE` del `UPDATE`.

| Situación | Respuesta |
|---|---|
| el ack avanza el estado | `200` con `advanced: true` |
| ack duplicado o atrasado | `200` con `advanced: false`, sin tocar nada |
| el último que faltaba | `200` con `batch.completed` y `batch.cleanedUp` |
| dispositivo fuera del snapshot | `404 DEVICE_NOT_IN_SNAPSHOT` |

`GET /v1/messages/:messageId/receipts/:deviceId` devuelve el recibo durable, que
**sobrevive al cleanup de los envelopes**.

### `GET /v1/messages/:messageId` y `GET /v1/operations/:key`

Consulta para recovery y para verificar invariantes. `GET /v1/operations/:key` requiere el
header `X-Actor-Id` y devuelve la respuesta persistida: **un cliente que perdió la respuesta
puede recuperarla sin reenviar el efecto**.

### Verlo funcionar

```bash
npm run demo
```

```bash
npm run demo:huecos
```

```bash
npm run demo:entrega
```

```bash
npm run demo:replicas
```

Cuatro demos narradas que levantan la API, mandan requests HTTP reales y muestran el estado de
cada tabla después de cada paso: el contrato de idempotencia, la política de huecos
(1, 3, 4 → 2, el hueco que vence y el resync) y la entrega multi-dispositivo (acks
duplicados y fuera de orden, con el CronJob corriendo en paralelo).

### El contrato en cuatro comandos

Con la app corriendo (`npm start`) y una conversación creada:

```bash
curl -i -X POST localhost:3000/v1/conversations/$CONV/messages -H 'content-type: application/json' -H 'Idempotency-Key: K1' -d "$BODY"
```

Repetir el mismo comando devuelve `200` con el mismo `messageId`. Cambiar el `body` sin
cambiar la key devuelve `409 IDEMPOTENCY_KEY_REUSED`. Y al final, la base tiene **un** mensaje,
**un** batch y **un** envelope por dispositivo.

## Levantar

Requiere Docker corriendo y Node ≥ 22.

```bash
cp .env.example .env && npm install && npm run db:up && npm run migrate
```

Postgres queda en `localhost:5433` (no 5432, para no chocar con un Postgres local).
Credenciales del laboratorio: `lab` / `lab`, base `whatsapp_lab`.

| Comando | Qué hace |
|---|---|
| `npm run db:up` | levanta Postgres y espera a que esté healthy |
| `npm run migrate` | aplica las migraciones pendientes |
| `npm run migrate:status` | muestra qué está aplicado y qué falta |
| `npm run db:reset` | **borra el volumen** y vuelve a levantar limpio |
| `npm run gaps:expire` | barre los huecos vencidos (el futuro CronJob) |
| `npm run deliveries:cleanup` | libera el trabajo de entrega terminado o vencido, y verifica I9 |
| `npm run db:down` | baja el contenedor conservando los datos |
| `npm run build` / `npm start` | compila y arranca una sola instancia |
| `npm run stack:up` | construye la imagen y levanta Postgres + 3 réplicas |
| `npm run stack:down` | baja el stack |
| `npm run stack:logs` | sigue los logs de las tres réplicas |

## Correr los tests

La base de tests (`whatsapp_lab_test`) se crea sola al levantar el contenedor por primera
vez, y las migraciones se aplican en el setup global de la suite.

```bash
npm run db:up && npm test
```

Los unit tests no necesitan Docker:

```bash
npm run test:unit
```

Un archivo suelto, o un caso puntual:

```bash
npx vitest run test/integration/messages.constraints.spec.ts -t "I5"
```

Los tests de integración y e2e corren contra PostgreSQL real, en serie y truncando entre
casos. No hay base en memoria ni mocks: una constraint de Postgres sólo se puede probar
contra Postgres.

| Suite | Qué cubre |
|---|---|
| `test/unit/` | fingerprint canónico: estabilidad, colisiones, tipos |
| `test/integration/*.constraints.spec.ts` | cada constraint del schema, probada por violación |
| `test/integration/send-message.spec.ts` | contrato de idempotencia, lease, fencing, **C1**, **C2** |
| `test/integration/order-and-gaps.spec.ts` | buffering, drenado, expiración y resync: **C3** |
| `test/integration/acks-and-cleanup.spec.ts` | monotonía, conteo, cleanup único y TTL: **C4** |
| `test/e2e/` | HTTP real: status, headers, códigos de error, probes, métricas |

## Cómo están escritos los tests

Cada test de constraint la **viola** y exige el SQLSTATE y el nombre exacto de la constraint
que tiene que rechazar la operación:

```ts
await expectViolation(
  () => insertMessage({ conversationId, senderDeviceId, clientSequence: 7 }),
  { code: '23505', constraint: 'messages_stream_client_sequence_uniq' },
);
```

Verificar el nombre, y no sólo que "algo falló", es lo que hace útil al test: si mañana
alguien borra el índice de I5 y el INSERT empieza a fallar por otro motivo — o deja de
fallar — el test lo dice con precisión.

Las tres constraints centrales tienen además un test de carrera con 20–40 operaciones
concurrentes, que es la forma en la que el problema aparece de verdad: N requests llegando a
la vez a réplicas distintas, todas creyendo ser la primera.

### Verificación por mutación

Los tests fueron validados borrando cada constraint y confirmando que fallan. Reproducible:

```bash
psql postgres://lab:lab@localhost:5433/whatsapp_lab_test -c "DROP INDEX messages_conversation_server_sequence_uniq;"
```

```bash
npx vitest run test/integration/messages.constraints.spec.ts -t "I5"
```

Sin el índice, el test de carrera reporta 30 mensajes en la posición 5 en lugar de 1. Para
restaurar el schema:

```bash
npm run db:reset && npm run migrate
```

## El modelo

```text
conversations ──┬── conversation_sequences   (contador de orden visible, 1 fila = 1 lock)
                ├── conversation_devices     (membresía mutable)
                └── device_sequences         (próximo client_sequence + política de huecos)

devices

idempotency_operations   (dueño durable de la key: fingerprint, status, recovery point,
                          attempt/fencing, respuesta reproducible)

messages ──┬── delivery_batches      snapshot inmutable  · se crea una vez, sobrevive
           │        ├── delivery_envelopes   trabajo pendiente   · SE BORRA en el cleanup
           │        └── delivery_receipts    estado durable      · NO se borra nunca
```

La separación entre **mensaje lógico**, **trabajo de entrega** y **recibo durable** es el
corazón del diseño. Si terminaran en una fila pasarían dos cosas a la vez: el cleanup
borraría la evidencia con la que se auditan las invariantes, y cada ack de cada dispositivo
competiría por la misma fila que todos los demás.

Hay dos órdenes distintos y no se confunden: `client_sequence` ordena el stream de un
dispositivo emisor; `server_sequence` es el orden visible de la conversación. Ninguno se
deriva de un timestamp — `created_at` existe para auditar, nunca para ordenar.

## Constraints e invariantes

Cada constraint lleva en la migración un comentario con la carrera concreta que previene.

| Invariante | Constraint | Migración |
|---|---|---|
| **I1** una key compatible produce un solo efecto | `idempotency_operations_actor_route_key_uniq` UNIQUE (actor_id, route, key) | [0002](migrations/0002_idempotency_operations.sql) |
| **I3** un retry completado devuelve el mismo resultado | `idempotency_operations_completed_has_response` | [0002](migrations/0002_idempotency_operations.sql) |
| **I4** un stream no repite `client_sequence` | `messages_stream_client_sequence_uniq` UNIQUE (conversation_id, sender_device_id, client_sequence) | [0003](migrations/0003_messages.sql) |
| **I5** `server_sequence` única por conversación | `messages_conversation_server_sequence_uniq` UNIQUE (conversation_id, server_sequence) **WHERE server_sequence IS NOT NULL** | [0003](migrations/0003_messages.sql) |
| **I6** un mensaje con hueco no se vuelve visible | `messages_published_iff_server_sequence` + política de huecos | [0003](migrations/0003_messages.sql) |
| **I7** un receipt nunca retrocede | `delivery_receipts_pkey` + `delivery_receipts_state_matches_timestamps` + `version` | [0004](migrations/0004_delivery.sql) |
| **I8** un ack duplicado no cuenta dos veces | `delivery_envelopes_message_device_uniq`, `delivery_batches_delivered_not_above_expected` | [0004](migrations/0004_delivery.sql) |
| **I9** no hay cleanup con dispositivos pendientes | `delivery_batches_cleanup_requires_completion_or_expiry` | [0005](migrations/0005_cleanup_reason.sql) |
| **I10** el cleanup final ocurre una sola vez | `UPDATE ... WHERE cleanup_at IS NULL` | [cleanup.repository.ts](src/infrastructure/persistence/cleanup.repository.ts) |

Dos aclaraciones honestas sobre el alcance de lo que el schema garantiza hoy:

- **I5 es parcial a propósito.** El índice sólo aplica a mensajes publicados: los buffered
  todavía no compiten por una posición y tienen que poder convivir de a muchos. Que la
  secuencia sea además *creciente* lo garantiza el contador de `conversation_sequences`
  tomado con `FOR UPDATE`, no el índice.
- **I7 no se resuelve con un CHECK.** Un CHECK no ve la fila anterior, así que no puede
  expresar "el nuevo estado debe ser ≥ el viejo". Lo que sí garantiza el schema es que
  ningún estado incoherente exista (un recibo `read` sin `delivered_at` es imposible). La
  monotonicidad se impone en el `WHERE` del `UPDATE`, comparando posiciones de estado con
  `array_position`, más un compare-and-set sobre `version`.

## Decisiones de acceso a datos

**Sin ORM.** El módulo de base expone el `Pool` de `pg` tal cual. Las transacciones, los
`FOR UPDATE`, el nivel de aislamiento y los códigos de error de Postgres quedan visibles en
el código que los usa. Una capa que los uniformara haría el código más corto y el sistema
imposible de explicar.

**Migraciones SQL escritas a mano**, versionadas y con checksum. El runner
([`migrator.ts`](src/infrastructure/database/migrator.ts)) toma un advisory lock antes de
aplicar — en Kubernetes las migraciones corren como Job, pero nada impide que dos las
lancen a la vez — y rechaza una migración ya aplicada que fue editada.

**Aislamiento por caso, no global.** El default es `READ COMMITTED` con constraints y locks
explícitos. Subir el aislamiento global sin medir sería tapar el problema en vez de
resolverlo. Cada decisión se documenta donde se toma.

**El cleanup declara por qué limpia.** Un batch se libera porque terminó o porque venció el
TTL, y esas dos cosas se distinguen y se auditan por separado — un `expired` nunca se
disfraza de entrega exitosa: [ADR 0003](docs/adr/0003-cleanup-con-razon-declarada.md).

**Ante un hueco, se preserva el orden y se sacrifica disponibilidad de ese dispositivo.**
Un mensaje adelantado espera; si el hueco vence, el stream se bloquea y el cliente decide.
El servidor nunca publica salteando un hueco:
[ADR 0002](docs/adr/0002-orden-antes-que-disponibilidad.md).

**Dos transacciones, no cuatro recovery points.** Tx1 reclama la idempotency key; Tx2 hace
todo el efecto en un solo commit. Por qué eso elimina las ventanas ambiguas internas, cuál
es la única ventana que queda y cómo la cubre el lease con fencing:
[ADR 0001](docs/adr/0001-una-transaccion-para-el-efecto.md).

**Inyección de dependencias explícita.** Los constructores usan `@Inject(TOKEN)` en vez de
inyección por tipo. La inyección por tipo depende de `emitDecoratorMetadata`, que emite
`tsc` pero **no** esbuild — el transpilador de Vitest. Sin token explícito la app funciona
compilada y falla en los tests con un `undefined` difícil de leer.

## Estructura

```text
docs/ALCANCE.md      alcance completo del proyecto (fuente de verdad, no editar)
docs/PENDIENTE.md    scope creep anotado para slices posteriores
docs/adr/            sólo decisiones que cambian una garantía
migrations/          SQL versionado, con el race que previene cada constraint
src/domain/          fingerprint, errores y tipos del dominio
src/application/     SendMessageService, AckService y los dos barridos
src/infrastructure/  pool, migrator y repositorios SQL
src/http/            controller, validación de entrada y mapeo de errores
test/unit/           lógica pura, sin base
test/integration/    constraints y contrato contra Postgres real
test/e2e/            HTTP real contra una instancia
infra/docker/        init de la base
scripts/migrate.ts   CLI de migraciones
```
