# Resultados de carga y fallos

Corridas del 16 de agosto de 2026. Todo lo que sigue se midió ejecutando; cada número
tiene abajo el comando que lo produce.

**El criterio de éxito nunca es "k6 en verde".** ALCANCE lo dice sin vueltas: *"El test de
aplicación y el test de carga deben consultar la base al final. Contar respuestas `2xx` no
demuestra ninguna de estas propiedades."* Por eso cada escenario termina con
`npm run verify`, que audita I1–I10 contra los datos y sale con código 1 si algo se rompió.

## Entorno

| | |
|---|---|
| Cluster | k3d 5.9.0, k3s v1.30.14, 1 server + 2 agents |
| API | 3 réplicas, una por nodo por regla (`topologySpreadConstraints`) |
| Postgres | 1 réplica, `StatefulSet` con PVC. **No** es HA, y es a propósito |
| Pool | 10 conexiones por pod, `connectionTimeout` 5 s, `statement_timeout` 10 s |
| Carga | k6 v2.2.0 desde el host, **por el Ingress**, modelo **abierto** |
| Población | seed reproducible, 10 conversaciones × 4 dispositivos = 40 streams |

**Ruido de fondo, que importa:** la máquina tenía 8 contenedores de otros proyectos
corriendo (redpanda, jaeger, 4 Postgres). No se bajaron por no ser de este repo.

## 1. Línea de base — sistema sano

```bash
npm run k6:base
```

| Corrida | p95 | avg | max | creados | fallos | violaciones |
|---|---|---|---|---|---|---|
| A | 14.70 ms | 11.13 ms | 143 ms | 600 | 0 | — |
| B | 14.47 ms | 11.18 ms | 124 ms | 601 | 0 | — |

20 req/s durante 30 s. Dos corridas separadas difieren en 0.23 ms: **a este ritmo la
medición es estable**, y eso es lo que la vuelve utilizable como referencia.

## 2. I11 — matar una réplica durante la carga

> I11: *matar una réplica no cambia ninguna de las anteriores.*

```bash
npm run caos:pod-kill                 # SIGTERM, con drenaje
MODO=abrupto npm run caos:pod-kill    # SIGKILL, sin drenaje
```

| Escenario | Carga | p95 | creados | fallos HTTP | mensajes en la base | **violaciones I1–I10** |
|---|---|---|---|---|---|---|
| Kill grácil | 20/s × 60 s | 15.89 ms | 1200 | 0 | 1200 | **0** |
| Kill abrupto | 20/s × 60 s | 15.34 ms | 1201 | 0 | 1201 | **0** |
| Kill abrupto | 300/s × 40 s | 6.27 ms | 11809 | 0 | 11809 | **0** |

**Lo que esto demuestra:** en las tres corridas los mensajes creados según el cliente
coinciden exactamente con los mensajes en la base, `operaciones_falladas` quedó en 0 y la
auditoría de I1–I10 no encontró nada. Matar una réplica —con drenaje o sin él— no rompió
ninguna invariante. **Eso es I11, y está cumplido.**

**Lo que esto NO demuestra, y conviene no leerlo de más.** Que el kill diera cero fallos no
es evidencia de resiliencia: es evidencia de que el experimento fue suave.

- A 20 req/s con ~11 ms de latencia, por Little hay **0.23 requests en vuelo en todo el
  sistema**. La probabilidad de que matar un pod interrumpa alguno es de un puñado por
  ciento. Cero fallos era el resultado esperado incluso si el sistema fuera frágil.
- A 300 req/s el kill sí tendría a quién pegarle, pero ahí **el ruido se come el efecto**.
  Corrida de control, misma carga y **sin matar nada**:

  | Corrida (300/s × 40 s) | p95 | max | iteraciones descartadas |
  |---|---|---|---|
  | **con** kill abrupto | 6.27 ms | 800 ms | 192 |
  | **sin** kill (control) | 41.39 ms | 677 ms | 342 |

  La corrida sin matar nada salió *peor* en p95 y descartó *más* iteraciones que la corrida
  con el kill. Una tercera corrida con otra distribución de streams (40 conversaciones × 1
  dispositivo) dio p95 6.45 ms. Es decir: **la misma configuración da entre 6 ms y 41 ms de
  p95 según la corrida**. Con esa varianza, cualquier comparación de latencia a 300 req/s en
  esta máquina no significa nada.

**Conclusión honesta:** I11 está verificado sobre invariantes, que es lo que I11 afirma. El
**costo en latencia** de matar un pod todavía no se puede medir acá. Para medirlo harían
falta n≥5 corridas por condición comparando distribuciones, y una máquina sin ocho
contenedores ajenos compitiendo.

## 3. Toxiproxy — degradar la conexión API → PostgreSQL

```bash
TOXIC=ninguno npm run caos:toxiproxy                 # control: proxy sin toxic
TOXIC=latency LATENCIA=100 npm run caos:toxiproxy    # 100 ms ± 10 de jitter
```

**Tres condiciones y no dos.** Comparar "sin proxy" contra "con proxy y latencia" mezclaría
dos cambios. El control aísla cuánto cuesta el proxy solo.

| Condición | p95 | avg | throughput logrado | descartadas | fallos | violaciones |
|---|---|---|---|---|---|---|
| Directo a Postgres | 14.47 ms | 11.18 ms | 20/s de 20 | 0 | 0 | 0 |
| Proxy, **sin** toxic | 21.98 ms | 14.03 ms | 20/s de 20 | 0 | 0 | 0 |
| Proxy, **+100 ms** | **6.64 s** | 5.11 s | **6.98/s de 20** | 354 | 0 | **0** |

### El proxy solo cuesta ~7 ms de p95

De 14.47 a 21.98 ms sin ningún toxic. Es el precio de meter un salto de red más, y hay que
descontarlo de cualquier lectura del experimento.

### 100 ms de latencia se convierten en 6.64 segundos

Amplificación de ~50×, y no es un misterio: **un envío no hace un round-trip a la base, hace
del orden de diez** (reclamar la key, tomar el lock del contador, insertar el mensaje, abrir
el batch, insertar envelopes y receipts, cerrar la operación, `COMMIT`). Cien milisegundos
por viaje son ~1 segundo antes de que exista contención.

El resto lo pone el diseño: ese lock del contador de la conversación se toma con
`SELECT … FOR UPDATE` y **se sostiene durante todos esos viajes lentos**. Con 40 streams
sobre 10 conversaciones, cuatro streams se serializan detrás de cada contador. La latencia
no se suma, se multiplica por la cola.

Esto le pone número a una deuda que estaba anotada como intuición en PENDIENTE (*"el drenado
en cascada publica de a uno dentro de la transacción que tiene tomado el lock"* y *"medir
lock vs. optimista"*): **con la base lenta, el lock por conversación es el cuello, y el costo
es de dos órdenes de magnitud.**

### Lo que aguantó

Con el sistema a 6.64 s de p95 y descartando el 59% de las llegadas: **cero respuestas
fallidas y cero violaciones de invariantes**. Ninguna request devolvió error — sólo
tardaron. El `statement_timeout` de 10 s no llegó a dispararse (el máximo fue 8.02 s), así
que este experimento midió degradación, **no** el camino de error por timeout. Ese camino
sigue sin probarse.

## Lo que queda sin medir

- **El costo en latencia de un pod kill.** Necesita n≥5 por condición y menos ruido.
- **`TOXIC=reset_peer`**: está implementado en el script pero no se corrió.
- **El camino de timeout**: subir la latencia por encima de los 10 s de `statement_timeout`
  para ver qué error devuelve el sistema y si la invariante aguanta cuando *sí* falla.
- **I6, I7 e I10** no se auditan desde el estado final; los cubren tests de integración. El
  verificador lo dice en cada corrida en vez de sumarlas al "todo verde".
