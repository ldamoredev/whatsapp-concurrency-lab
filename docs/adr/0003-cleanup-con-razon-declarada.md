# ADR 0003 — El cleanup declara por qué limpia

**Estado:** aceptada · Slice 4 · 9 de agosto de 2026

## Contexto

En el slice 1 escribí esta constraint para proteger I9 (*no se limpian envelopes mientras
quede un dispositivo esperado pendiente*):

```sql
CONSTRAINT delivery_batches_cleanup_requires_completion
    CHECK (cleanup_at IS NULL OR completed_at IS NOT NULL)
```

Al implementar el slice 4 resultó **más estricta que el alcance**, que dice:

> el cleanup de envelopes ocurre una sola vez y sólo cuando todos los dispositivos del
> snapshot llegaron al estado terminal de entrega acordado, **o cuando vence el TTL**

Un batch que vence por TTL nunca se completa. Con aquel CHECK, limpiarlo era imposible: los
envelopes de un dispositivo que jamás vuelve a conectarse quedarían acumulándose para
siempre. La constraint que protegía una invariante impedía un requisito.

## Decisión

**No aflojar la constraint hasta que deje de proteger nada. Hacer explícita la razón.**

La migración `0005` agrega `cleanup_reason` y reemplaza el CHECK por tres:

```sql
-- la razón es un valor del dominio, no texto libre
CHECK (cleanup_reason IS NULL OR cleanup_reason IN ('completed', 'expired'))

-- limpiar y declarar por qué son el mismo hecho
CHECK ((cleanup_at IS NULL) = (cleanup_reason IS NULL))

-- I9: 'completed' exige que realmente se haya completado
CHECK (
  cleanup_reason IS NULL
  OR (cleanup_reason = 'completed' AND completed_at IS NOT NULL)
  OR cleanup_reason = 'expired'
)
```

Un cleanup sin ninguna de las dos razones sigue siendo imposible. Lo que cambia es que ahora
hay **dos** razones legítimas y se distinguen.

## Por qué importa la distinción

Después del cleanup los envelopes ya no están. Sin `cleanup_reason`, un batch limpio con
receipts en `pending` es ambiguo: ¿se entregó a todos y estos receipts son de dispositivos
que se agregaron después? ¿o se abandonó?

Con la razón declarada, la verificación de I9 se puede escribir:

```sql
SELECT b.message_id
  FROM delivery_batches b
  JOIN delivery_receipts r ON r.message_id = b.message_id
 WHERE b.cleanup_reason = 'completed'
 GROUP BY b.message_id, b.expected_count
HAVING count(*) FILTER (WHERE r.state IN ('delivered','read')) < b.expected_count;
```

Tiene que devolver cero siempre. Los batches `expired` quedan fuera **a propósito**: ahí sí
había pendientes, y está registrado que se abandonaron. Un `expired` no se disfraza de
entrega exitosa — `completed_at` sigue `NULL`.

Esta query es posible sólo porque los receipts sobreviven al cleanup. Si el estado de
entrega viviera en el envelope, el cleanup habría borrado justo la evidencia que hace falta
para auditar que el cleanup estuvo bien.

## Dónde vive la idempotencia del cleanup (I10)

En el `WHERE`, no en un lock:

```sql
UPDATE delivery_batches
   SET cleanup_at = now(), cleanup_reason = CASE ... END
 WHERE message_id = $1
   AND cleanup_at IS NULL                                    -- ← la puerta
   AND (completed_at IS NOT NULL OR expires_at < now())      -- ← I9
```

Dos caminos compiten por esa puerta a propósito: el ack que completa el batch y el CronJob
que barre. Pueden llegar al mismo tiempo desde pods distintos. Uno se lleva la fila; el otro
actualiza 0 filas y no borra nada. No hace falta líder ni lock global.

El `DELETE` de envelopes va en la **misma transacción** que la puerta. Separados, un proceso
que muriera en el medio dejaría el batch marcado como limpio con sus envelopes todavía ahí,
y nadie los volvería a mirar.

En el barrido masivo se agrega `FOR UPDATE SKIP LOCKED`: dos workers se reparten el trabajo
en vez de pelearse por las mismas filas.

## Y la idempotencia del ack (I8)

Aparte, y por otro mecanismo. El progreso se incrementa **únicamente cuando el receipt cruza
el umbral terminal por primera vez**, en la misma transacción que ese cambio:

```ts
const cruzoElUmbral =
  !reachesTerminal(current.state, terminal) && reachesTerminal(updated.state, terminal);
```

Atarlo al cambio real de estado — y no a "llegó un ack" — es lo que hace idempotente al
conteo. Veinte acks del mismo dispositivo mueven el recibo una vez, así que suman una vez.
El CHECK `delivery_batches_delivered_not_above_expected` es la red debajo.

## Estado terminal configurable

`DELIVERY_TERMINAL_STATE`, default `delivered`. `read` sigue siendo recibo de producto, no
requisito para liberar trabajo: un usuario que nunca abre el chat no puede dejar envelopes
colgados para siempre. Con `read` como terminal, el sistema funciona igual — hay un test que
lo verifica — pero el trabajo se retiene más tiempo.

## La lección

Una constraint puede estar **bien escrita y mal calibrada**. Aquella no tenía un bug: hacía
exactamente lo que decía. El problema es que decía más de lo que el dominio permitía, y eso
sólo se descubrió al implementar el caso que prohibía.

Vale la pena notar cómo se manifestó: **no como un bug en producción, sino como una
migración necesaria dos slices después**. Ese es el costo real de una constraint demasiado
estricta, y es mucho más barato que el de una demasiado laxa.
