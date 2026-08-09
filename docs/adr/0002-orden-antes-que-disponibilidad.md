# ADR 0002 — Ante un hueco, se preserva el orden y se sacrifica disponibilidad

**Estado:** aceptada · Slice 3 · 8 de agosto de 2026

## Contexto

Un dispositivo numera sus mensajes con `client_sequence`: 1, 2, 3… La red no garantiza que
lleguen en ese orden. Llega el 1, después el 3.

¿Qué se hace con el 3?

| Opción | Consecuencia |
|---|---|
| **A. Publicarlo ya** | los destinatarios ven "3" antes que "2". El orden deja de existir |
| **B. Esperar al 2, para siempre** | un mensaje perdido congela el stream indefinidamente |
| **C. Esperar al 2 con un plazo** | hay que decidir qué pasa cuando el plazo vence |

Y si se elige C, la pregunta difícil llega después: **vencido el plazo, ¿se publica el 3 o
no?**

## Decisión

**C, y al vencer el plazo el servidor NO publica.** El stream pasa a `resync_required` y
deja de aceptar mensajes hasta que el cliente resuelva explícitamente qué hacer.

Concretamente:

1. Llega el esperado → se publica, y se **drena** en cascada todo lo contiguo que estaba
   esperando, en un solo `COMMIT`.
2. Llega uno mayor → queda `buffered`: existe en la base, pero **sin `server_sequence` y sin
   deliveries**. Para la conversación todavía no pasó nada. Se responde `202 Accepted`.
3. Llega uno menor ya procesado → replay del mensaje existente.
4. El hueco no se completa dentro del deadline → el barrido lo pasa a `resync_required`.
5. En `resync_required` sólo se acepta el mensaje que falta. Cualquier otro recibe
   `409 STREAM_RESYNC_REQUIRED`, **con el próximo esperado en el cuerpo**.
6. El cliente puede reenviar el que falta, o pedir un resync explícito declarando desde
   dónde sigue: `POST /v1/conversations/:id/devices/:id/stream/resync`.

## Por qué el servidor no salta el hueco solo

Publicar el 3 sin el 2 significa que un destinatario ve una conversación con un salto que
nunca se va a llenar, y **no tiene forma de saber que falta algo**. El daño es silencioso: no
hay error, no hay señal, sólo una conversación sutilmente incorrecta.

El cliente, en cambio, sí sabe cosas que el servidor no: si aquel mensaje 2 sigue en su cola
de salida, si el usuario lo canceló, o si se perdió sin retorno. **Es quien puede decidir.**

Por eso la única forma de saltar un hueco es un endpoint que el cliente invoca a propósito.
`resync_required` no es un estado de error: es el sistema diciendo *"no puedo seguir sin que
me digas qué pasó"*.

## Qué se sacrifica, dicho sin vueltas

**Disponibilidad de escritura de ese dispositivo, en esa conversación.** Mientras el hueco
está abierto, sus mensajes se aceptan pero no se publican. Vencido el plazo, se rechazan.

El alcance es acotado a propósito:

- afecta a **un** dispositivo en **una** conversación
- los otros dispositivos del mismo usuario siguen publicando normalmente
- la conversación sigue recibiendo mensajes de todos los demás
- nada de lo ya publicado se toca

Este proyecto es un chat: un mensaje fuera de orden es peor que un mensaje demorado. En un
sistema de telemetría, donde perder orden es tolerable y perder disponibilidad no, la
decisión correcta sería la opuesta.

## Detalles que costaron una decisión

**El deadline se fija una sola vez.** Se mide desde que apareció el hueco, no desde el
último mensaje que llegó. Si se reiniciara con cada mensaje adelantado, un cliente que sigue
mandando 5, 6, 7 mientras falta el 2 empujaría el vencimiento para siempre y el hueco no
expiraría nunca. Está en `markWaitingGap` (sólo actualiza `WHERE state = 'ok'`) y probado en
`el deadline del hueco NO se estira al seguir mandando adelantados`.

**El hueco del cliente no se traslada a la conversación.** Tras un resync que saltea el
`client_sequence` 5, el mensaje 6 recibe `server_sequence` 5 — el siguiente lugar libre. Son
dos numeraciones independientes: el agujero del stream de un emisor no tiene por qué
agujerear el orden visible de todos.

**El orden de los locks es fijo:** primero `device_sequences`, después
`conversation_sequences`, y el segundo sólo si hay algo que publicar. Invertirlo en algún
camino produciría deadlocks entre dos transacciones que publican a la vez en la misma
conversación.

**El barrido no necesita líder ni lock global.** Todo el vencimiento es un solo `UPDATE`
condicional (`WHERE state = 'waiting_gap' AND gap_deadline < now()`), lo que lo hace
idempotente y seguro con N workers concurrentes: el segundo simplemente no encuentra filas.
Probado con cinco barridos simultáneos.

## Cuándo revisar esta decisión

- Si el `gapTimeoutMs` produce demasiados `resync_required` en la práctica. El valor
  correcto sale de medir, no de intuir.
- Si aparece un cliente que no puede implementar el contrato de resync: ahí el problema es
  el contrato, no el timeout.
- Si el drenado en cascada se vuelve largo. Hoy publica de a uno dentro de la transacción que
  tiene tomado el lock del contador de la conversación; con cientos de mensajes bufferizados
  esa transacción se estira y bloquea al resto de la conversación.
