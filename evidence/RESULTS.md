# Resultados de carga y fallos — L1 a L4

Corridas del 15 y 16 de agosto de 2026. Todo se midió ejecutando; cada número tiene al
lado el comando que lo produce.

**El criterio de éxito nunca es "k6 en verde".** ALCANCE lo dice sin vueltas: *"El test de
aplicación y el test de carga deben consultar la base al final. Contar respuestas `2xx` no
demuestra ninguna de estas propiedades."* Por eso cada escenario termina con
`npm run verify`, que audita I1–I10 contra los datos y sale con código 1 si algo se rompió.

## Entorno

| | |
|---|---|
| Cluster | k3d 5.9.0, k3s v1.30.14, 1 server + 2 agents |
| API | 3 réplicas, una por nodo por regla; `cpu 100m–1`, `memoria 192Mi–512Mi` |
| Postgres | 1 réplica, `StatefulSet` con PVC. **No** es HA, y es a propósito |
| Pool | **10 conexiones por pod**, `connectionTimeout` 5 s, `statement_timeout` 10 s |
| Carga | k6 v2.2.0 desde el host, **por el Ingress**, modelo **abierto** |
| Observabilidad | Prometheus + Grafana como código (`npm run obs:up`) |

**Ruido de fondo, que importa:** la máquina tenía 8 contenedores de otros proyectos
corriendo (redpanda, jaeger, 4 Postgres). No se bajaron por no ser de este repo.

---

## L1 — Carga sostenida

```bash
npm run k6:l1     # 100 ops/s durante 5 min
```

La mezcla que pide ALCANCE, no un solo tipo de request: **60% envíos únicos, 20% acks, 15%
retries equivalentes, 5% conflictos deliberados**. Cada uno toca un camino distinto —el
envío toma el lock del contador, el retry es un `SELECT`, el conflicto rechaza sin ejecutar,
el ack es un `UPDATE` condicional— y un p95 agregado sobre cuatro costos no dice cuál se
degradó. Por eso hay un `Trend` por operación.

**La conversación caliente es estructural, no un porcentaje de tráfico.** El orden se asigna
por `(conversación, dispositivo)`, así que dos generadores sobre el mismo stream se pisan el
`client_sequence` y producen conflictos que no tienen que ver con la carga. El calor real se
fabrica sembrando la conversación 0 con **40 dispositivos** en vez de 4: cada VU sigue siendo
dueño exclusivo de su stream y aun así 40 compiten por la **única fila** de
`conversation_sequences` de esa conversación.

| Corrida | p95 | p99 | descartadas | inesperados | violaciones |
|---|---|---|---|---|---|
| 1ª | 26.36 ms ✓ | **901 ms ✗** | **11 ✗** | 0.00% ✓ | 0 |
| 2ª | 12.46 ms ✓ | 409.93 ms ✓ | 0 ✓ | 0.00% ✓ | 0 |

Umbrales de ALCANCE: p95 < 250 ms, p99 < 750 ms, `dropped_iterations == 0`, errores < 1%.

**La misma configuración pasó y falló.** No se bajó ningún umbral —ALCANCE lo prohíbe
explícitamente— y la diferencia entre corridas es del entorno, no del código. El p99 es la
métrica inestable: 409 ms contra 901 ms.

### El costo de la conversación caliente, medido

| | p95 | avg |
|---|---|---|
| Envío a conversación normal | 33.55 ms | 39.43 ms |
| **Envío a la conversación caliente** | **59.45 ms** | 54.83 ms |

**1.8× más lento en p95** por el mismo trabajo. Eso es el `SELECT … FOR UPDATE` sobre una
fila, visible como número.

### El primer cuello, con métricas

Durante la corrida, leído de Prometheus:

| Métrica | Máximo |
|---|---|
| `lab_pg_pool_connections{state="total"}` | **10** (el techo) |
| `lab_pg_pool_connections{state="active"}` | **10** |
| `lab_pg_pool_connections{state="waiting"}` | **9** |
| `lab_http_inflight_requests` por pod | 14 – 20 |
| `lab_event_loop_lag_seconds{quantile="max"}` | 0.065 s |

**El cuello es el pool, no la CPU ni el event loop.** Con 14–20 requests en vuelo por pod
contra 10 conexiones, hasta 9 esperan turno. La cola de la p99 es tiempo esperando conexión.

Esto responde con datos una pregunta que estaba abierta desde el slice 2: *"el pool está fijo
en 10 y el número correcto sale de L1/L3, no de una intuición"*. **A 100 ops/s, 10 es
insuficiente: es el primer recurso que se agota.**

---

## L2 — Réplica eliminada durante la carga

```bash
npm run caos:pod-kill                 # SIGTERM, con drenaje
MODO=abrupto npm run caos:pod-kill    # SIGKILL, sin drenaje
```

Durante el plateau de L1 (100 ops/s, mezcla completa), se mata un pod a los 60 s.

| | Resultado |
|---|---|
| p95 / p99 | 9.78 ms / 46.02 ms ✓ |
| `dropped_iterations` | 0 ✓ |
| Respuestas inesperadas | 0.00% de 18 000 ✓ |
| Checks | 20 715 / 20 715 |
| **Violaciones I1–I10** | **0** |

**Reparto por réplica durante el kill** (req/s, cada 15 s; el kill fue a los ~60 s):

```
victima  ghhpj    0.6   1.1  21.1  33.9  34.0  33.6  14.7   ·     ·     ·
reemplazo 9bk8c    ·     ·     ·     ·     ·     ·   22.6  33.9  34.0  33.9
superviv. pc6zb   0.6   3.8  23.8  34.0  33.8  35.4  36.6  34.0  33.9  34.0
superviv. ztnb7   0.6   4.2  24.2  33.9  34.0  35.6  36.6  34.0  34.0  34.0
replicas listas    3     3     3     3     3     2     3     3     3     3
```

Los cuatro criterios de L2:

- **Kubernetes crea el reemplazo** ✓ — `9bk8c` aparece y toma tráfico.
- **La carga sigue cruzando ≥2 réplicas** ✓ — `pc6zb` y `ztnb7` nunca bajaron de 34 req/s.
- **Sin duplicados ni acks perdidos** ✓ — auditoría en cero, y los retries devolvieron el
  mismo `messageId` (I3) durante todo el evento.
- **Vuelve al SLO en <30 s** ✓ — `lab_ready` estuvo en 2 durante **un solo bucket de 15 s**.

### Lo que estas corridas NO demuestran

Cero fallos no es evidencia de resiliencia por sí solo. A 20 req/s con ~11 ms de latencia,
por Little hay **0.23 requests en vuelo en todo el sistema**: matar un pod casi nunca
interrumpe alguno. Y a 300 req/s, donde sí interrumpiría, el ruido se come el efecto — la
corrida de **control sin matar nada** salió *peor* (p95 41.39 ms, 342 descartadas) que la
corrida con el kill (6.27 ms, 192). **El costo en latencia de un pod kill no se puede medir
en esta máquina**; haría falta n≥5 por condición.

---

## L3 — PostgreSQL lento y cortando conexiones

```bash
npm run caos:l3
```

Cuatro fases sobre 4 minutos a 20 ops/s: limpio → **+100 ms de latencia** → **cortes de
conexión (`reset_peer`, 40%)** → se retira todo el fallo.

**Los criterios de L3 no son de latencia.** La latencia se degradó muchísimo y tenía que
hacerlo: p95 8.14 s, p99 10.9 s, 32% de respuestas inesperadas, envíos al 53% de éxito. Lo
que L3 pregunta es otra cosa.

**Series leídas de Prometheus, por fase:**

```
                    limpio-----  +latencia-------  +cortes---------  recuperacion
HTTP 200      1.7   9.4   8.3    7.7   8.9   6.2   6.9   6.7   8.0   8.3   9.3
HTTP 201      0.0  11.8   8.2    5.7   7.0   3.6   1.2   1.4   1.4   1.7   1.4
HTTP 409      0.0   0.8   1.3    0.8   1.1   3.1   4.3   4.9  10.5  11.9  12.2
HTTP 500      2.3   0.1   0.8    3.3   3.5   1.7   0.0   0.0   0.0   0.0   0.0
pool waiting  0     0     0       34    84    75    0     0     0     0     0
replicas listas  3  3     3        3     3     3    3     3     3     3     3
```

| Criterio de L3 | Resultado |
|---|---|
| Rechaza o vence por timeout **acotado**, sin acumular trabajo infinito | ✓ — `pool waiting` subió a 84 y **volvió a 0**; los 500 aparecieron, se mantuvieron ≤3.5/s y cesaron |
| **Liveness no reinicia todos los pods** por una dependencia compartida | ✓ — `lab_ready` se mantuvo en **3** toda la corrida, 0 restarts |
| Recupera **sin restart manual** | ✓ — al sacar los toxics, 500 → 0 y `pool waiting` → 0 solo |
| Los retries no multiplican la carga | ✓ — modelo abierto, tasa de llegada fija, sin reintento interno |
| **Invariantes en cero** | ✓ |

### El resultado más importante de todo el laboratorio

Auditoría contra la base al terminar la secuencia de fallas:

```
operaciones                8599
operaciones_completadas    7395
mensajes                   7395     <- exactamente iguales
operaciones_falladas       1151
operaciones_en_curso         53
I1, I2, I3, I4, I5, I8 e I9: cero violaciones
```

**1151 operaciones fallaron y 53 quedaron ambiguas, y no se duplicó ni se perdió nada.**
`operaciones_completadas == mensajes` exactamente: cada operación que dijo haber terminado
produjo un mensaje, ni uno más ni uno menos. Eso es lo que el laboratorio existe para
demostrar.

### Dos observaciones honestas

- **El 409 crece durante los cortes** (hasta 12.2/s). No es un bug: es
  `IdempotencyInProgressError`. Cuando el dueño de una key muere a mitad, la operación queda
  `in_progress` y los reintentos reciben 409 hasta que vence el lease. El sistema prefiere
  decir "esto está en curso" antes que arriesgar un segundo efecto.
- **El "timeout acotado" es la suma de varios, no uno.** El máximo observado fue **22.43 s**
  con un `statement_timeout` de 10 s y un `connectionTimeout` de 5 s. No se violó ninguno:
  un request hace varias queries y espera una conexión, y esos límites se suman. Un request
  puede tardar mucho más que cualquiera de sus timeouts individuales, y ese total hoy no
  está acotado por nada.

---

## L4 — Escalones hasta el primer límite

```bash
npm run k6:l4
```

| rps pedido | p95 | p99 | logrado | descartadas | pool esperando |
|---|---|---|---|---|---|
| 50 | 20.16 ms | 87.98 ms | 50/s | 0 | **0** |
| 100 | 232.74 ms | 837.02 ms | 100/s | 0 | **8** |
| 200 | 4.38 s | 6.87 s | **98/s** | 4614 | **269** |
| 400 | 3.89 s | 5.96 s | 286/s | 13691 | 270 |
| 50 (vuelta) | 12.94 ms | 104.1 ms | 50/s | 0 | recuperado |

**Qué se saturó primero:** el pool de conexiones. La progresión de `waiting` (0 → 8 → 269) es
la única métrica que se mueve antes que la latencia. El event loop nunca pasó de 65 ms.

**Cómo degradó:** entre 100 y 200 req/s el sistema pasa de p95 de 232 ms a 4.38 s — no es una
curva suave, es un codo. A partir de ahí la latencia deja de crecer (3.89 s a 400/s) porque
lo que crece es la cola: se completan menos operaciones, no más lentas.

**Si recuperó:** sí, y solo. Al volver a 50 req/s el p95 bajó a 12.94 ms sin intervención.
Invariantes en cero al final de toda la escalera.

**No le llamo "capacidad" a 98/s.** A 200 req/s pedidos con 4.38 s de latencia harían falta
~876 VUs (Little) y el escenario corrió con 300: **el generador estaba limitado por VUs**, así
que 98/s es un piso observado, no el techo del sistema. Lo que sí es del sistema, y no del
generador, es dónde está la cola: 269 conexiones esperando en el pool.

---

## Observabilidad

```bash
npm run obs:up      # Prometheus + Grafana, dashboard incluido
```

Datasource y tablero se provisionan desde ConfigMaps: un dashboard armado a mano vive en el
navegador de una persona y se pierde al recrear el cluster.

Prometheus descubre los tres pods por un Service **headless** y `dns_sd_configs` — el Service
normal balancea y scrapearía "algún" pod cada vez. Con `honor_labels: true` gana el label
`instance` de la aplicación, que es el **nombre del pod**; sin eso Prometheus lo pisa con
`ip:puerto`, que cambia en cada reinicio y no contesta "qué réplica atendió".

**Ningún `userId`, `messageId` ni idempotency key es label.** `route` es la ruta con
parámetros (`/v1/messages/:messageId/acks`), no la URL concreta.

El tablero contesta las cinco preguntas de ALCANCE en una pantalla: SLO por ruta,
invariantes violadas (stat en rojo si ≠ 0), req/s por réplica, pool y event loop, y
réplicas listas + resultados de idempotencia para ver la recuperación.

---

## Lo que queda sin medir

- **El costo en latencia de un pod kill**, por el ruido de la máquina.
- **Subir el pool y volver a medir.** L1 y L4 identifican el pool de 10 como el primer
  límite, pero *no* se probó que subirlo mueva el codo — podría simplemente trasladar la
  contención al lock del contador o a Postgres.
- **El total de un request no está acotado.** Los timeouts individuales existen; su suma no.
- **I6, I7 e I10** no se auditan desde el estado final; los cubren tests de integración, y el
  verificador lo dice en cada corrida en vez de sumarlas al "todo verde".
