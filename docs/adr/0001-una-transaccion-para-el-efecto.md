# ADR 0001 — El efecto entero va en una sola transacción

**Estado:** aceptada · Slice 2 · 8 de agosto de 2026

## Contexto

El alcance define cuatro recovery points para el envío idempotente:

```text
started → message_persisted → deliveries_created → completed
```

y exige que cada paso sea reentrante. También permite explícitamente colapsarlos:

> Si todos los efectos quedan dentro de una única transacción corta, se pueden colapsar
> recovery points, pero el README de implementación debe explicar por qué no existe una
> ventana ambigua interna.

Este ADR ejerce esa opción y explica por qué.

## Decisión

El envío usa **dos transacciones**, no cuatro pasos:

**Tx1 — reclamar la key.** Un solo `INSERT` en `idempotency_operations` con
`status = 'in_progress'`, `attempt = 1` y un `lease_until`. Commitea sola.

**Tx2 — el efecto completo.** En una única transacción:

1. `SELECT ... FROM conversation_sequences WHERE conversation_id = $1 FOR UPDATE`
2. `INSERT INTO messages (...)` ya publicado, con su `server_sequence`
3. `UPDATE conversation_sequences SET next_server_sequence = next_server_sequence + 1`
4. snapshot de destinatarios + `delivery_batches` + `delivery_envelopes` + `delivery_receipts`
5. `UPDATE idempotency_operations SET status = 'completed', response_body = ... WHERE id = $1 AND attempt = $2`

Un solo `COMMIT`. La operación salta de `started` a `completed` sin pasar por los
recovery points intermedios.

## Por qué no hay una ventana ambigua interna

La pregunta que un recovery point contesta es: *"me caí a mitad de camino, ¿qué parte del
efecto quedó hecha?"*.

Dentro de Tx2 esa pregunta **no tiene sentido**, porque no hay estados intermedios
observables. PostgreSQL garantiza que otra sesión vea todo el efecto o nada de él. Si el
proceso muere en cualquier punto entre el paso 1 y el paso 5, la transacción no commitea y
el servidor la aborta: no queda un mensaje sin deliveries, ni deliveries sin batch, ni una
respuesta guardada sin su mensaje.

Concretamente, estos tres estados son **irrepresentables**, no "improbables":

| Estado intermedio | Por qué no puede existir |
|---|---|
| mensaje publicado sin `delivery_batch` | mismo COMMIT que el batch |
| `delivery_envelopes` sin `delivery_receipts` | mismo COMMIT |
| operación `completed` sin mensaje | mismo COMMIT, y `idempotency_operations_completed_has_response` exige la respuesta |

Un recovery point que distinguiera `message_persisted` de `deliveries_created` describiría
una diferencia que la base no puede producir.

Esto tiene una consecuencia concreta en el código: cuando el `INSERT` del mensaje choca
contra I4 y hay que decidir si es un replay, el servicio **no necesita** verificar si las
deliveries existen. Si el mensaje existe, existen — están en el mismo commit.

## La ventana que sí existe, y qué la cubre

Entre Tx1 y Tx2 **sí** hay una ventana. Si el proceso muere ahí, la operación queda
`in_progress` para siempre, con un mensaje que nunca se creó.

No se resuelve con recovery points, sino con un **lease** y un **fencing token**:

- La operación lleva `lease_until`. Mientras está vigente, otro request con la misma key
  recibe `409 IDEMPOTENCY_IN_PROGRESS` con `Retry-After`.
- Cuando vence, cualquier proceso puede retomarla con
  `UPDATE ... SET attempt = attempt + 1 WHERE id = $1 AND attempt = $2 AND lease_until < now()`.
  El `WHERE attempt` hace que sólo uno gane.
- El owner viejo, si revive, intenta cerrar con su `attempt` antiguo. Su `UPDATE` toca
  **0 filas**, el servicio lanza `IdempotencyLeaseLostError` y el `ROLLBACK` de Tx2
  descarta el mensaje y las deliveries que acababa de crear.

`lease_until < now()` se evalúa en el reloj de **PostgreSQL**, no en el de la API: con tres
pods hay tres relojes, y tres respuestas distintas a "¿ya venció?".

Tests que lo demuestran, en [`send-message.spec.ts`](../../test/integration/send-message.spec.ts):
`retoma una operacion abandonada cuando el lease vencio, subiendo el attempt` y
`un owner viejo NO puede completar una operacion cuyo lease ya perdio`.

## Por qué Tx1 va separada

La alternativa sería meter el `INSERT` de la operación dentro de Tx2. Funcionaría —
Postgres bloquea al segundo insert de una key duplicada hasta que el primero commitee— pero
tiene dos costos:

1. **Contención.** Los otros 99 requests concurrentes quedarían *bloqueados* durante toda
   la transacción larga en vez de recibir una respuesta inmediata.
2. **Deja de existir `IDEMPOTENCY_IN_PROGRESS`**, que el alcance pide explícitamente como
   parte del contrato.

Con Tx1 separada, el `23505` llega enseguida y el cliente recibe un `409` con `Retry-After`
en milisegundos, en vez de una conexión colgada.

## Costo aceptado

`recovery_point` queda con dos valores en uso (`started` y `completed`) de los cuatro que
el schema admite. Se mantienen los cuatro en la constraint porque el camino es parte del
contrato del proyecto y porque una implementación futura con efectos repartidos en varias
transacciones —por ejemplo, si el fan-out de deliveries se volviera asincrónico— los
necesitaría sin migración.

## Cuándo revisar esta decisión

- Si el snapshot de destinatarios crece a miles de dispositivos: Tx2 dejaría de ser corta,
  y tiene tomado el lock del contador de la conversación. Ahí conviene separar
  `deliveries_created` a una transacción propia y volver a usar el recovery point.
- Si L1 muestra contención en `conversation_sequences` como primer cuello de botella.
