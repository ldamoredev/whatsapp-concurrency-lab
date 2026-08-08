# WhatsApp — agosto 2026

**Fecha de fin: 31 de agosto.** El 1 de septiembre se abre [Twitter](../twitter/README.md), esté como
esté esto.

**La primitiva: idempotencia, orden y concurrencia sobre estado compartido, demostrados en una
topología multi-réplica.**

Estado: no arrancado.

## Por qué este mes es el más importante de los cuatro

Es el que cierra el hueco textual del feedback de Cashea:

> *"Los dos desafíos centrales del ejercicio — cómo manejar la concurrencia en el stock y cómo
> garantizar idempotencia en el pago — son problemas clásicos en sistemas transaccionales y donde
> esperamos solidez en un perfil senior. En esta instancia no llegamos a ver esa profundidad en la
> implementación."*

Los dos problemas están adentro de un chat, con otro vocabulario:

| Problema de WhatsApp | Es el mismo que… |
|---|---|
| El cliente reintenta con mala señal y no se puede duplicar | **Idempotencia en el pago** |
| Tres dispositivos ackean el mismo mensaje | **Concurrencia sobre estado compartido** |
| El orden no se puede confiar al reloj del servidor | Reloj lógico |
| Recibos: enviado → entregado → leído | **Máquina de estados persistida** |
| Borrado del envelope cuando todos ackearon | Invariante en la base |

## La tesis del proyecto

No se construye WhatsApp. Se construye un laboratorio que permite afirmar y demostrar:

> Un cliente puede perder una respuesta y reintentar contra otra réplica; varios dispositivos
> pueden confirmar al mismo tiempo; un pod puede morir durante la carga. Aun así se crea un solo
> mensaje lógico, el estado sólo avanza, el orden definido se conserva y ningún envelope se elimina
> antes de que corresponda.

La arquitectura existe para hacer visibles esas carreras. Kubernetes, Traefik y las réplicas no son
decoración de portfolio: obligan a que la corrección viva en datos compartidos y no en la memoria de
un proceso.

## Alcance funcional cerrado

### S1 — Modelo de dominio

Separar explícitamente:

- **`Message`:** mensaje lógico, único e inmutable en identidad.
- **`DeliveryBatch`:** snapshot de los dispositivos que deben recibir ese mensaje.
- **`DeliveryEnvelope`:** trabajo pendiente por mensaje y dispositivo.
- **`DeliveryReceipt`:** estado durable por dispositivo; no desaparece al limpiar el envelope.
- **`IdempotencyOperation`:** operación del cliente, fingerprint, estado y respuesta reproducible.
- **`ConversationSequence`:** contador de orden visible de una conversación.
- **`DeviceSequence`:** próximo `clientSequence` esperado para un dispositivo dentro de la
  conversación.

La separación entre mensaje lógico, trabajo de entrega y recibo durable es el corazón del sistema.
Sin ella, idempotencia, multi-device y cleanup quedan mezclados en una sola fila.

### S2 — Envío idempotente

`POST /v1/conversations/:conversationId/messages` recibe:

- header `Idempotency-Key` generado por el cliente;
- `senderId`, `senderDeviceId`, `clientMessageId`, `clientSequence` y `body`;
- un fingerprint canónico de todos los campos que definen el efecto.

El contrato:

1. Primera ejecución válida: crea el mensaje y devuelve `201`.
2. Misma key y mismo fingerprint completado: devuelve el mismo `messageId` y resultado persistido,
   sin repetir el efecto.
3. Misma key con otro fingerprint: `409 IDEMPOTENCY_KEY_REUSED`; no ejecuta nada.
4. Misma key y mismo fingerprint todavía en curso: `409 IDEMPOTENCY_IN_PROGRESS` con `Retry-After`.
5. Si el commit ocurrió y la respuesta se perdió, el retry recupera el resultado ya persistido.
6. Una operación abandonada puede retomarse desde un recovery point sin volver a crear el mensaje.

La key se scopea por actor y operación, por ejemplo `(senderId, route, idempotencyKey)`. No vive sólo
en Redis ni en memoria: una constraint única durable decide el dueño.

La operación tiene un `attempt` creciente. Los updates finales verifican ese attempt para que un
proceso viejo no pueda completar una operación cuyo lease ya perdió. El efecto además tiene
constraints propias; el fencing evita autoridad vieja y la unicidad protege aun si la aplicación
tiene un bug.

Recovery points mínimos:

```text
started → message_persisted → deliveries_created → completed
```

Cada paso debe ser reentrante. Si todos los efectos quedan dentro de una única transacción corta, se
pueden colapsar recovery points, pero el README de implementación debe explicar por qué no existe una
ventana ambigua interna.

### S3 — Orden por conversación y huecos

Hay dos órdenes distintos:

- `clientSequence`: orden del stream de un dispositivo emisor;
- `serverSequence`: orden visible asignado por conversación cuando el mensaje queda publicable.

No se usa `createdAt` para decidir orden. Las constraints mínimas son:

- único `(conversationId, senderDeviceId, clientSequence)`;
- único `(conversationId, serverSequence)` cuando ya fue publicado;
- único `clientMessageId` dentro del scope acordado.

Política de huecos:

1. Si llega el esperado, se publica y se drena cualquier secuencia contigua ya bufferizada.
2. Si llega uno mayor, queda `buffered`; todavía no recibe orden visible ni genera deliveries.
3. Si llega uno menor ya procesado, es replay: devuelve el mensaje existente.
4. Si el hueco no se completa dentro del deadline configurado, el stream pasa a `resync_required`.
5. En `resync_required` no se salta silenciosamente el hueco: el cliente consulta el próximo número
   esperado y reenvía o reinicia su stream mediante un contrato explícito.

La elección preserva orden y sacrifica disponibilidad para ese dispositivo. Eso es deliberado y
tiene que quedar explicado; esperar para siempre tampoco es una solución.

### S4 — Entrega multi-dispositivo

Al publicar un mensaje se toma un snapshot inmutable de dispositivos destinatarios. Para cada uno se
crea un envelope pendiente y un receipt durable.

`POST /v1/messages/:messageId/acks` recibe `deviceId` y estado `delivered` o `read`.

Reglas:

- el estado sólo avanza `pending → delivered → read`;
- repetir el mismo ack es idempotente;
- un ack atrasado no hace retroceder el estado;
- un dispositivo fuera del snapshot no cambia el batch;
- `expectedCount` no cambia si después se agrega o elimina un dispositivo;
- el cleanup de envelopes ocurre una sola vez y sólo cuando todos los dispositivos del snapshot
  llegaron al estado terminal de entrega acordado, o cuando vence el TTL;
- los receipts y el batch completado sobreviven al cleanup para poder auditar la invariante;
- TTL y cleanup son idempotentes y seguros frente a dos workers concurrentes.

Para el laboratorio, el estado terminal que habilita cleanup debe estar fijado por configuración y
documentado. El default es `delivered`; `read` continúa como recibo de producto, no como requisito
para liberar trabajo de entrega.

## Invariantes no negociables

Estas invariantes deben existir como constraints, transacciones o updates condicionales en Postgres,
no sólo como `if` en TypeScript:

| ID | Invariante | Evidencia |
|---|---|---|
| I1 | una idempotency key compatible produce un solo efecto lógico | constraint + test de carrera |
| I2 | misma key con fingerprint distinto nunca ejecuta | respuesta `409` + conteo en DB |
| I3 | un retry completado devuelve el mismo `messageId` | response persistida + test |
| I4 | no hay dos mensajes para el mismo stream y `clientSequence` | índice único |
| I5 | `serverSequence` es única y creciente dentro de la conversación | constraint + query |
| I6 | un mensaje con hueco no se vuelve visible antes que sus predecesores | test 1,3,4,2 |
| I7 | un receipt nunca retrocede | update condicional + test fuera de orden |
| I8 | un ack duplicado no incrementa dos veces el progreso | unicidad + test concurrente |
| I9 | no se limpian envelopes mientras quede un dispositivo esperado pendiente | query de verificación |
| I10 | el cleanup final ocurre una sola vez | transición condicional + métrica |
| I11 | matar una réplica no cambia ninguna de las anteriores | escenario de resiliencia |

El test de aplicación y el test de carga deben consultar la base al final. Contar respuestas `2xx`
no demuestra ninguna de estas propiedades.

## Arquitectura local obligatoria

```text
                      ┌──────────────────────── k3d / Kubernetes ────────────────────────┐
k6 ──> k3d server LB ──> Traefik Ingress ──> ClusterIP Service ─┬─> API pod 1 ─┐        │
                                                               ├─> API pod 2 ─┼─> Toxiproxy ─> PostgreSQL
                                                               └─> API pod 3 ─┘        │
                                                                                         │
Prometheus <── /metrics por pod <────────────────────────────────────────────────────────┤
Grafana    <── Prometheus                                                               │
                                                                                         │
Migration Job ───────────────────────────────────────────────────────────────> PostgreSQL│
Cleanup CronJob ─────────────────────────────────────────────────────────────> PostgreSQL│
                      └───────────────────────────────────────────────────────────────────┘
```

### Decisiones cerradas

- **Runtime:** Node.js LTS + TypeScript + NestJS con Fastify.
- **Datos:** PostgreSQL como única source of truth.
- **Acceso a datos:** SQL y transacciones visibles; no esconder locks, isolation ni constraints
  detrás de una abstracción que impida explicarlos.
- **Cluster local:** k3d con al menos dos agent nodes.
- **Entrada:** Traefik. No agregar Nginx además de Traefik.
- **Aplicación:** tres pods detrás de un `Service`, sin sticky sessions.
- **Carga:** k6 desde fuera del cluster contra el único punto de entrada.
- **Fallos de red/dependencia:** Toxiproxy entre API y Postgres, sólo como instrumento del lab.
- **Métricas:** endpoint Prometheus y dashboard Grafana mínimo.
- **Logs:** JSON estructurado con `requestId`, `operationId`, `messageId` e `instanceId` cuando existan.

Redis y RabbitMQ **no son obligatorios ni deseables en esta versión**. No hay session registry,
fan-out masivo ni pipeline offline en alcance. La coordinación correcta entra en una base
transaccional. Agregarlos “para que parezca producción” crea dos autoridades y diluye el problema
que se quiere demostrar.

### Objetos de Kubernetes requeridos

- namespace dedicado;
- `Deployment` de API con `replicas: 3`;
- `Service` `ClusterIP` y `Ingress` de Traefik;
- `StatefulSet` de PostgreSQL con PVC para el laboratorio;
- `Deployment` y `Service` de Toxiproxy;
- `Job` de migraciones, separado del arranque de cada pod;
- `CronJob` de expiración/cleanup, con ejecución manual posible para tests;
- `ConfigMap` y `Secret` local sin credenciales reales commiteadas;
- requests y limits de CPU/memoria;
- startup, readiness y liveness probes con responsabilidades distintas;
- `PodDisruptionBudget` con al menos dos APIs disponibles;
- topology spread o anti-affinity para repartir las APIs entre nodos locales;
- security context no-root, filesystem de sólo lectura si la aplicación lo permite y sin token de
  service account cuando no se usa;
- `NetworkPolicy` si el CNI local elegido la implementa; si no, documentar el límite.

PostgreSQL tiene una sola réplica en el laboratorio. Eso prueba consistencia de aplicación y
recovery de pods, **no alta disponibilidad de la base ni tolerancia de zona**. No se debe afirmar lo
contrario.

### Lifecycle de la API

- liveness: el proceso/event loop puede progresar;
- readiness: no está drenando y tiene capacidad local para aceptar trabajo; evitar un check remoto
  profundo que reinicie o retire todo durante una degradación compartida;
- startup: protege migración de runtime/boot lento, aunque las migraciones de schema vivan en un Job;
- `SIGTERM`: marcar no-ready, dejar de aceptar requests, drenar inflight, cerrar pool y salir dentro
  del grace period;
- timeouts y pool acotados: una base lenta no puede crear espera infinita.

La respuesta local agrega `X-Instance-Id` o un campo equivalente, además de la métrica por pod, para
probar que el load balancer distribuyó requests. No hace falta una distribución perfecta; sí
evidencia de que al menos dos réplicas procesaron las carreras críticas.

## Modelo de datos mínimo

El nombre exacto puede cambiar, pero el schema debe hacer visibles estas decisiones:

```text
conversations
conversation_sequences(conversation_id, next_server_sequence, version)
devices
conversation_devices
device_sequences(conversation_id, device_id, next_client_sequence, state, gap_deadline)

idempotency_operations(
  actor_id, route, key, fingerprint,
  status, recovery_point, attempt, resource_id,
  response_status, response_body, lease_until, expires_at
)

messages(
  id, client_message_id, conversation_id, sender_id, sender_device_id,
  client_sequence, server_sequence nullable, status, body, created_at
)

delivery_batches(message_id, expected_count, delivered_count, completed_at, cleanup_at, expires_at)
delivery_envelopes(message_id, device_id, state, created_at)
delivery_receipts(message_id, device_id, state, delivered_at, read_at, version)
```

Las migraciones deben incluir constraints, índices y comentarios breves sobre el race que protege
cada uno. La decisión de usar `READ COMMITTED` con locks explícitos, `SERIALIZABLE` con retry, o una
combinación se documenta por caso; no se sube el aislamiento global sin medir y justificar.

## Suite de pruebas obligatoria

### Código

- unit tests de fingerprint, máquina de estados y política de huecos;
- integración contra PostgreSQL real para constraints, locks y aislamiento;
- e2e HTTP contra una instancia para contratos y errores;
- nada crítico se valida sólo con mocks.

### C1 — Carrera de idempotencia

Lanzar al menos 100 requests concurrentes con la misma key y body.

Pass:

- exactamente un mensaje lógico;
- exactamente un batch de delivery;
- ninguna delivery duplicada;
- respuestas sólo `201`, replay o `IDEMPOTENCY_IN_PROGRESS` esperados;
- un retry posterior devuelve el mismo resultado persistido.

Repetir con la misma key y body distinto: todas las variantes incompatibles devuelven conflicto y el
estado original queda intacto.

### C2 — Operación ambigua

Un failpoint habilitado **sólo en el entorno de test** corta el socket o descarta la respuesta después
del commit y antes de que el cliente la reciba. El cliente reintenta la misma key contra el ingress.

Pass: obtiene el resultado original y en la base hay un solo efecto. Un `500` antes del commit no
sirve para simular este caso.

### C3 — Orden y huecos

Enviar `clientSequence` 1, 3 y 4; verificar que 3 y 4 quedan bufferizados. Enviar 2 y verificar orden
visible 1, 2, 3, 4 con `serverSequence` consecutiva. Crear otro hueco que venza y verificar
`resync_required`, sin publicación silenciosa.

### C4 — Ack multi-device

Para un mensaje con tres dispositivos:

1. dos dispositivos mandan acks duplicados y fuera de orden;
2. verificar que todavía existen envelopes pendientes;
3. el tercero ackea concurrentemente varias veces;
4. verificar receipts monotónicos, conteo correcto y un único cleanup;
5. repetir mientras corre también el CronJob de cleanup para forzar la carrera.

### L1 — Carga sostenida

Modelo abierto con k6 contra Traefik, no contra pods:

- referencia inicial: 100 operaciones/s durante 5 minutos;
- mezcla de envíos únicos, retries equivalentes, conflictos deliberados y acks;
- dataset precreado, varias conversaciones y al menos una hot conversation;
- tres pods con recursos fijos y documentados;
- `dropped_iterations == 0`;
- errores inesperados `< 1%`;
- p95 `< 250 ms` y p99 `< 750 ms` para operaciones exitosas en la máquina de referencia;
- cero violaciones de I1–I11.

Si el hardware no sostiene esa referencia, se conserva la forma del workload, se documenta el
primer límite y se fija un baseline reproducible. No se baja el número sólo para obtener verde sin
explicar el cuello de botella.

### L2 — Réplica eliminada durante carga

Durante el plateau de L1, eliminar un API pod elegido al azar.

Pass:

- Kubernetes crea el reemplazo;
- la carga sigue atravesando al menos dos réplicas;
- no aparecen duplicados ni acks perdidos;
- los errores inesperados se mantienen dentro del threshold;
- el sistema vuelve al SLO en menos de 30 segundos desde que el reemplazo queda ready.

### L3 — PostgreSQL lento

Con Toxiproxy, agregar latencia y luego cortar temporalmente conexiones a Postgres mientras sigue una
carga menor y estable.

Observar pool active/waiting, acquire timeout, inflight, errores y latencia. Pass:

- la API rechaza o vence por timeout acotado, no acumula trabajo infinito;
- liveness no reinicia todos los pods por una dependencia compartida;
- al retirar el fallo recupera sin restart manual;
- los retries no multiplican la carga sin límite;
- las invariantes siguen en cero violaciones.

### L4 — Stress y recovery

Subir en escalones hasta encontrar el primer límite. Esto no tiene un RPS de aprobación: el
entregable es identificar con métricas qué se saturó primero, cómo degradó y si recuperó al volver al
baseline. No llamar “capacidad” a un número si el generador estaba saturado.

## Observabilidad mínima

### Métricas de usuario y aplicación

- requests, errores y duración por ruta/status;
- inflight y rechazos/timeouts;
- requests por `instanceId`;
- resultados de idempotencia: owner, replay, conflict, in-progress, recovered;
- operaciones por recovery point y edad de las atascadas;
- mensajes publicados/buffered/resync-required;
- gaps activos y edad;
- acks por transición, duplicados y regresiones rechazadas;
- envelopes pendientes, edad y cleanup count;
- violaciones de invariantes detectadas: siempre cero.

### Saturación y dependencias

- CPU, memoria y restarts por pod;
- event-loop lag;
- pool de Postgres: max, active, idle, waiting y acquire duration;
- duración/error/timeout de queries por operación normalizada;
- lock waits, deadlocks y serialization retries;
- estado de Toxiproxy durante los escenarios.

No usar `userId`, `messageId` ni idempotency keys como labels Prometheus. Van hasheados o completos en
logs estructurados, correlacionados por IDs.

El dashboard mínimo responde en una pantalla:

1. ¿el cliente puede enviar y ackear dentro del SLO?;
2. ¿las invariantes siguen sanas?;
3. ¿qué réplica recibió tráfico?;
4. ¿qué recurso se saturó?;
5. ¿el sistema recuperó después del fallo?

## Automatización y estructura esperada del repo de implementación

```text
src/                    dominio, aplicación, HTTP e infraestructura
migrations/             SQL versionado
test/unit/
test/integration/
test/e2e/
load/k6/                escenarios y checks
load/faults/            pod kill, Toxiproxy y failpoints
infra/docker/
infra/k3d/
infra/k8s/base/
infra/k8s/overlays/local/
infra/observability/    Prometheus, Grafana y dashboard
scripts/                comandos finos usados por Make/just
evidence/RESULTS.md     última corrida aceptada
docs/adr/               sólo decisiones que cambian una garantía
Makefile o justfile
README.md
```

Comandos equivalentes requeridos, aunque cambie el task runner:

```text
cluster-up     crea k3d multi-node e instala dependencias
build          compila y construye imagen
deploy         carga imagen, migra y aplica manifests
smoke          valida health, routing y migraciones
test           unit + integration + e2e
load           ejecuta baseline y carga sostenida
faults         ejecuta pod kill, operación ambigua y DB lenta
verify         corre invariantes post-test y falla si alguna se rompe
evidence       genera el resumen reproducible
cluster-down   elimina sólo el cluster de este proyecto
```

Los comandos deben ser idempotentes y validar prerequisitos. `cluster-down` no puede borrar clusters,
volúmenes o imágenes ajenos.

## Evidencia que debe quedar commiteada

`evidence/RESULTS.md` registra:

- fecha, commit, versiones y características de la máquina;
- diagrama/topología, réplicas y límites;
- workload exacto y seed;
- thresholds;
- distribución de requests por pod;
- timeline de cada fallo;
- p50/p95/p99, errores y dropped iterations;
- pool, locks, restarts y tiempo de recovery;
- resultado de cada invariante con query reproducible;
- primer cuello de botella del stress test;
- qué demuestra el laboratorio y qué no.

Se guardan resúmenes JSON pequeños y dashboards/config como código. No se commitean dumps de base,
logs gigantes ni artefactos que no se puedan relacionar con un criterio de aceptación.

## Qué queda afuera, a propósito

- UI, contactos y producto completo;
- WebSocket, presencia y session registry;
- grupos y fan-out masivo;
- multimedia y cifrado end-to-end;
- notificaciones push y offline queue;
- Kafka/RabbitMQ, Redis y service mesh;
- Postgres HA, multi-región y tolerancia real de zona;
- HPA como requisito de cierre: puede ser un experimento, no reemplaza las tres réplicas fijas;
- cloud deploy: el entregable es local, reproducible y observable.

WebSocket y offline son problemas reales de WhatsApp, pero no contestan el feedback que originó este
mes. Si entran antes de cerrar I1–I11, son scope creep.

## Terminado cuando

- [ ] Los cuatro slices están implementados y sus contratos documentados.
- [ ] I1–I11 están protegidas en datos y verificadas automáticamente.
- [ ] Unit, integration y e2e pasan contra PostgreSQL real donde corresponde.
- [ ] Un único comando crea un k3d multi-node reproducible.
- [ ] Hay tres APIs sin estado detrás de Traefik y evidencia de distribución.
- [ ] PostgreSQL persiste en PVC y las migraciones corren como Job.
- [ ] Probes, resources, PDB, spread y graceful shutdown están probados.
- [ ] Prometheus y Grafana muestran negocio, réplicas, pools y recovery.
- [ ] C1–C4 y L1–L4 pasan o producen el resultado explícitamente exigido.
- [ ] El pod kill ocurre durante carga, no como demo separada.
- [ ] La operación ambigua ocurre después del commit y el retry no duplica.
- [ ] Toxiproxy demuestra degradación acotada y recovery de Postgres lento.
- [ ] `verify` consulta la base y devuelve exit code no cero ante cualquier violación.
- [ ] `evidence/RESULTS.md` permite auditar la última corrida sin relato oral.
- [ ] El README levanta desde cero, ejecuta todo y destruye sólo recursos propios.
- [ ] Puedo contar tesis, arquitectura, carrera, fallo, señal y límite en 90 segundos sin mirar.

Poder contarlo es lo que convierte el trabajo en munición de entrevista. El despliegue y las pruebas
existen para que esa explicación esté respaldada por comportamiento observado, no por una maqueta.

---

## Prompt para arrancar el proyecto con un agente

Copiar este prompt en una tarea nueva, abierta **desde el repo dedicado de implementación**. Si el
agente está parado en `second-brain`, no debe meter la aplicación dentro del repositorio de notas:
primero hay que abrir o crear el repo del laboratorio.

```text
Quiero que construyas de punta a punta un laboratorio backend llamado
`whatsapp-concurrency-lab`. No es un clon de WhatsApp: demuestra idempotencia, orden por
conversación y concurrencia multi-dispositivo bajo carga y fallos en Kubernetes local.

Trabajá como agente de implementación, no como consultor. Inspeccioná primero el repo, sus
instrucciones y el working tree; preservá cambios ajenos. Después proponé un plan corto y avanzá
hasta tener evidencia ejecutada. No declares terminado algo que sólo está escrito. No hagas push,
no crees remotos y no despliegues a cloud. Si hace falta instalar Docker, k3d, kubectl, Helm o k6,
detectalo y pedí autorización antes de modificar la máquina.

Objetivo demostrable
--------------------
Un cliente puede perder una respuesta y reintentar contra otra réplica; varios dispositivos pueden
ackear concurrentemente; un pod puede morir durante carga. El resultado debe seguir siendo un solo
mensaje lógico, estados monotónicos, orden explícito y cleanup únicamente cuando corresponda.

Stack y topología obligatorios
------------------------------
- Node.js LTS, TypeScript, NestJS con Fastify.
- PostgreSQL como única source of truth. Usá SQL/migraciones y hacé visibles transacciones,
  constraints, locks e isolation; no escondas la parte importante detrás del ORM.
- Docker multi-stage, runtime no-root e imagen reproducible.
- k3d multi-node con al menos dos agent nodes.
- 3 pods de API stateless, Service ClusterIP y Traefik Ingress sin sticky sessions.
- PostgreSQL StatefulSet con PVC local.
- Toxiproxy entre API y Postgres para inyectar latencia/cortes en tests.
- Migration Job y cleanup CronJob.
- Prometheus + Grafana, métricas de aplicación y dashboard como código.
- k6 ejecutado desde fuera del cluster contra el único punto de entrada.
- No agregues Redis, RabbitMQ, Kafka, Nginx ni service mesh: no resuelven una necesidad de este
  alcance y crearían autoridades extra.

Dominio y contratos
-------------------
Modelá como conceptos separados:
- Message lógico.
- DeliveryBatch con snapshot inmutable de dispositivos esperados.
- DeliveryEnvelope por dispositivo como trabajo pendiente.
- DeliveryReceipt durable y monotónico por dispositivo.
- IdempotencyOperation con key, fingerprint, status, recovery point, attempt, lease y respuesta.
- ConversationSequence para orden visible.
- DeviceSequence para clientSequence y política de huecos.

Implementá al menos:
1. POST /v1/conversations/:conversationId/messages
   Header Idempotency-Key; body con senderId, senderDeviceId, clientMessageId, clientSequence y body.
2. POST /v1/messages/:messageId/acks
   Body con deviceId y state delivered/read.
3. Endpoint de consulta de operación/mensaje útil para recovery y tests.
4. Health startup/readiness/liveness y /metrics.

Semántica de idempotencia:
- primera ejecución crea y devuelve 201;
- misma key + mismo fingerprint completado devuelve exactamente el mismo messageId/resultado;
- misma key + fingerprint distinto devuelve 409 IDEMPOTENCY_KEY_REUSED sin efecto;
- operación concurrente en curso devuelve 409 IDEMPOTENCY_IN_PROGRESS + Retry-After;
- si el commit ocurrió pero la respuesta se perdió, el retry recupera el resultado;
- recovery points: started -> message_persisted -> deliveries_created -> completed, salvo que
  demuestres que una única transacción corta elimina de verdad las ventanas intermedias;
- attempt/fencing y constraints del efecto deben impedir que un owner viejo complete o duplique.

Semántica de orden:
- clientSequence ordena el stream de un dispositivo;
- serverSequence es única y creciente por conversación;
- no uses timestamps para decidir orden;
- con 1,3,4, el 3 y 4 quedan buffered; al llegar 2 se publica 1,2,3,4;
- un hueco vencido lleva el stream a resync_required; no esperes infinito ni saltes en silencio.

Semántica multi-device:
- al publicar, snapshot inmutable de dispositivos y un envelope/receipt por cada uno;
- pending -> delivered -> read, nunca hacia atrás;
- ack duplicado es idempotente;
- dispositivo ajeno al snapshot no altera el batch;
- cleanup de envelopes una sola vez cuando todos alcanzan delivered o vence TTL;
- receipts y batch final sobreviven para auditar;
- forzá la carrera entre acks y cleanup CronJob.

Invariantes obligatorias
------------------------
I1 una key compatible produce un solo efecto lógico.
I2 key con fingerprint distinto nunca ejecuta.
I3 retry completado devuelve el mismo messageId.
I4 único (conversationId, senderDeviceId, clientSequence).
I5 único y creciente serverSequence por conversación.
I6 los mensajes con hueco no se hacen visibles antes de sus predecesores.
I7 receipts monotónicos.
I8 ack duplicado no incrementa progreso dos veces.
I9 no hay cleanup con dispositivos esperados pendientes.
I10 cleanup final ocurre una sola vez.
I11 matar/recrear una réplica no rompe I1-I10.

Protegelas principalmente con UNIQUE/CHECK/FK, transacciones, row locks o updates condicionales en
Postgres. Los tests deben consultar la base al final; respuestas HTTP verdes no alcanzan.

Kubernetes obligatorio
-----------------------
Incluí namespace, Deployment replicas=3, Service, Ingress Traefik, PostgreSQL StatefulSet/PVC,
Toxiproxy, migration Job, cleanup CronJob, ConfigMap/Secret local, requests/limits, startup/readiness/
liveness probes, PDB minAvailable=2, topology spread/anti-affinity, graceful SIGTERM y security
context no-root. Agregá NetworkPolicy si el CNI la soporta; si no, documentá el límite.

La API debe exponer instanceId en header o respuesta sólo para el laboratorio y medir requests por
pod. Demostrá que las carreras atravesaron al menos dos réplicas. PostgreSQL será single replica:
no afirmes HA de base ni tolerancia de zona.

Pruebas que tenés que ejecutar
------------------------------
C1: 100 requests concurrentes con la misma key/body: un mensaje, un batch, deliveries únicas; retry
posterior devuelve mismo resultado. Repetí key con body diferente y verificá conflicto sin efecto.

C2: failpoint sólo de test que corta socket/descarta respuesta después del commit. Retry por ingress:
mismo resultado y un solo efecto. No simules esto con un 500 previo al commit.

C3: secuencia 1,3,4,2 y hueco vencido: buffer, publicación ordenada y resync_required.

C4: tres dispositivos, acks duplicados y fuera de orden. Con sólo dos, envelopes siguen; con el
tercero y CronJob concurrente, receipts correctos y un cleanup.

L1: k6 constant-arrival-rate, referencia 100 ops/s por 5 min, mix de sends/retries/conflicts/acks,
hot conversation, tres pods con recursos fijos. Thresholds iniciales: dropped_iterations=0, errores
inesperados <1%, p95<250ms, p99<750ms para éxitos y cero invariantes rotas. Si la máquina no llega,
documentá el primer límite y fijá un baseline honesto; no bajes números silenciosamente.

L2: durante el plateau eliminá un API pod. Debe recrearse, conservar invariantes y volver al SLO en
menos de 30s desde readiness.

L3: Toxiproxy agrega latencia y corta temporalmente Postgres bajo carga menor. Pools/timeouts deben
estar acotados, liveness no debe reiniciar todo, recovery sin restart manual y sin retry storm.

L4: stress en escalones hasta el primer límite y vuelta al baseline. Identificá con métricas qué se
saturó y verificá recovery. Medí también el generador para no confundir su techo con el del sistema.

Observabilidad y evidencia
--------------------------
Métricas mínimas: RED HTTP, inflight, requests por pod, resultados/recovery points de idempotencia,
mensajes published/buffered/resync, gaps y edad, transiciones/duplicados de ack, envelopes y cleanup,
event-loop lag, pool active/idle/waiting/acquire duration, query duration/errors/timeouts, lock waits,
deadlocks, serialization retries, CPU/memoria/restarts y contador de invariantes rotas.

No uses IDs ni keys como labels Prometheus. Usá logs JSON con requestId, operationId, messageId e
instanceId. El dashboard debe mostrar: experiencia/SLO, invariantes, distribución por réplica,
saturación y recovery.

Automatización y entregables
----------------------------
Creá estructura para src, migrations, tests unit/integration/e2e, load/k6, load/faults, infra/k3d,
infra/k8s base+overlay local, observability, scripts, docs/adr y evidence/RESULTS.md.

Ofrecé comandos equivalentes a:
- cluster-up, build, deploy, smoke;
- test, load, faults, verify, evidence;
- cluster-down, limitado exclusivamente al cluster de este proyecto.

Los comandos deben ser idempotentes, validar prerequisitos y devolver exit code no cero ante fallos.
Unit/integration/e2e forman la base; nada crítico sólo con mocks. verify debe ejecutar queries de
I1-I11 después de carga y fallos.

evidence/RESULTS.md debe registrar commit, versiones, máquina, topología, límites, workload, seed,
thresholds, requests por pod, timeline de fallos, percentiles, errores, dropped iterations, pools,
locks, restarts, recovery, queries de invariantes, cuello de botella y límites del laboratorio. No
commitees dumps, secretos, logs enormes ni reportes opacos.

Forma de trabajo
----------------
Implementá por etapas verificables:
1. scaffold, schema, migraciones y tests de constraints;
2. idempotencia, orden/huecos y multi-device con integración real;
3. Docker y Kubernetes multi-réplica;
4. observabilidad, k6 y fallos;
5. corrida completa, evidencia y README desde cero.

Mantené los cambios chicos y coherentes. Si hacés commits, que sean uno por etapa y nunca incluyan
secretos ni artefactos accidentales. Antes de cerrar, levantá el cluster desde cero y ejecutá de
verdad smoke, tests, carga, fallos y verify. Reportá resultados medidos, no expectativas. Si algo no
puede ejecutarse por una limitación concreta del entorno, dejá preparado el comando reproducible,
mostrá exactamente el bloqueo y no marques el proyecto como terminado.
```
