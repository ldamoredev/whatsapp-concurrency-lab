# whatsapp-concurrency-lab

Laboratorio backend de **idempotencia, orden por conversación y concurrencia
multi-dispositivo sobre estado compartido**. No es un clon de WhatsApp: el chat es sólo el
vocabulario con el que se hacen visibles esas carreras.

El alcance completo del proyecto está en [`docs/ALCANCE.md`](docs/ALCANCE.md). Ese archivo
manda y no se edita desde acá.

## Estado: slice 1 de 4 — modelo de dominio y schema

Lo que existe hoy:

- Scaffold Node LTS + TypeScript + NestJS con Fastify (sin rutas de negocio todavía).
- PostgreSQL 16 en Docker Compose.
- Migraciones SQL versionadas con las 10 tablas del modelo mínimo y sus constraints.
- 63 tests de integración contra PostgreSQL real que prueban cada constraint **rompiéndola**.

Lo que **no** existe todavía, y es a propósito: endpoints HTTP, lógica de idempotencia,
política de huecos, acks, Kubernetes, k6, Toxiproxy, Prometheus. Ver
[`docs/PENDIENTE.md`](docs/PENDIENTE.md).

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
| `npm run db:down` | baja el contenedor conservando los datos |
| `npm run build` / `npm start` | compila y arranca la API (hoy sin rutas) |

## Correr los tests

La base de tests (`whatsapp_lab_test`) se crea sola al levantar el contenedor por primera
vez, y las migraciones se aplican en el setup global de la suite.

```bash
npm run db:up && npm test
```

Un archivo suelto, o un caso puntual:

```bash
npx vitest run test/integration/messages.constraints.spec.ts -t "I5"
```

Los tests corren contra PostgreSQL real, en serie y truncando entre casos. No hay base en
memoria ni mocks: una constraint de Postgres sólo se puede probar contra Postgres.

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
| **I6** un mensaje con hueco no se vuelve visible | `messages_published_iff_server_sequence` | [0003](migrations/0003_messages.sql) |
| **I7** un receipt nunca retrocede | `delivery_receipts_pkey` + `delivery_receipts_state_matches_timestamps` + `version` | [0004](migrations/0004_delivery.sql) |
| **I8** un ack duplicado no cuenta dos veces | `delivery_envelopes_message_device_uniq`, `delivery_batches_delivered_not_above_expected` | [0004](migrations/0004_delivery.sql) |
| **I9** no hay cleanup con dispositivos pendientes | `delivery_batches_cleanup_requires_completion` | [0004](migrations/0004_delivery.sql) |

Dos aclaraciones honestas sobre el alcance de lo que el schema garantiza hoy:

- **I5 es parcial a propósito.** El índice sólo aplica a mensajes publicados: los buffered
  todavía no compiten por una posición y tienen que poder convivir de a muchos. Que la
  secuencia sea además *creciente* lo garantiza el contador de `conversation_sequences`
  tomado con `FOR UPDATE`, no el índice.
- **I7 no se resuelve con un CHECK.** Un CHECK no ve la fila anterior, así que no puede
  expresar "el nuevo estado debe ser ≥ el viejo". Lo que sí garantiza el schema es que
  ningún estado incoherente exista (un recibo `read` sin `delivered_at` es imposible). La
  monotonicidad se impone con un UPDATE condicional sobre `version`, y se prueba en el
  slice 4.

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

## Estructura

```text
docs/ALCANCE.md      alcance completo del proyecto (fuente de verdad, no editar)
docs/PENDIENTE.md    scope creep anotado para slices posteriores
migrations/          SQL versionado, con el race que previene cada constraint
src/                 scaffold NestJS + acceso a datos
test/integration/    constraints probadas por violación contra Postgres real
infra/docker/        init de la base
scripts/migrate.ts   CLI de migraciones
```
