-- 0005 — Por que se limpio un batch.
--
-- CORRECCION de una constraint del slice 1 que resulto mas estricta que el alcance.
--
-- 0004 escribio:
--
--     CONSTRAINT delivery_batches_cleanup_requires_completion
--         CHECK (cleanup_at IS NULL OR completed_at IS NOT NULL)
--
-- La intencion era I9: no se limpian envelopes mientras quede un dispositivo esperado
-- pendiente. Pero el alcance admite explicitamente una segunda razon para limpiar:
--
--     "el cleanup de envelopes ocurre una sola vez y solo cuando todos los
--      dispositivos del snapshot llegaron al estado terminal de entrega acordado,
--      O CUANDO VENCE EL TTL"
--
-- Un batch que vencio por TTL nunca se completa, asi que aquel CHECK volvia imposible
-- limpiarlo: los envelopes de un dispositivo que jamas vuelve a conectarse quedarian
-- acumulandose para siempre.
--
-- La correccion NO es aflojar la constraint hasta que deje de proteger nada. Es hacer
-- explicita la razon: un batch se limpia porque termino, o porque expiro, y esas dos
-- cosas se distinguen y se auditan por separado. Un cleanup sin ninguna de las dos
-- razones sigue siendo imposible.

ALTER TABLE delivery_batches
    ADD COLUMN cleanup_reason text;

COMMENT ON COLUMN delivery_batches.cleanup_reason IS
    'Por que se libero el trabajo de entrega: completed (todos ackearon) o expired (vencio el TTL).';


-- El CHECK viejo prohibia el cleanup por TTL. Se reemplaza, no se elimina.
ALTER TABLE delivery_batches
    DROP CONSTRAINT delivery_batches_cleanup_requires_completion;

ALTER TABLE delivery_batches
    ADD CONSTRAINT delivery_batches_cleanup_reason_valid
        CHECK (cleanup_reason IS NULL OR cleanup_reason IN ('completed', 'expired'));

-- La marca de limpieza y su razon son el mismo hecho: o estan las dos, o no esta
-- ninguna. Sin esto se podria limpiar sin dejar registro de por que, y la auditoria
-- de I9 despues del cleanup seria imposible: no habria forma de distinguir un batch
-- que termino de uno que se abandono.
ALTER TABLE delivery_batches
    ADD CONSTRAINT delivery_batches_cleanup_has_reason
        CHECK ((cleanup_at IS NULL) = (cleanup_reason IS NULL));

-- I9 — no se limpian envelopes mientras quede un dispositivo esperado pendiente.
--
-- RACE: dos workers de cleanup miran el mismo batch. Uno ve delivered_count = 2 de 3 y
-- decide limpiar igual por un bug de comparacion; los envelopes del tercer dispositivo
-- desaparecen y ese dispositivo no recibe el mensaje nunca. La constraint convierte ese
-- bug en un 23514 inmediato en vez de una entrega perdida en silencio.
--
-- La unica excepcion es el TTL, y tiene que ser deliberada: `expired` es una decision
-- de "este dispositivo no vuelve", no un atajo para saltear el conteo.
ALTER TABLE delivery_batches
    ADD CONSTRAINT delivery_batches_cleanup_requires_completion_or_expiry
        CHECK (
            cleanup_reason IS NULL
            OR (cleanup_reason = 'completed' AND completed_at IS NOT NULL)
            OR cleanup_reason = 'expired'
        );


-- Barrido del CronJob: los vencidos que todavia tienen trabajo colgando.
CREATE INDEX delivery_batches_expired_pending_cleanup_idx
    ON delivery_batches (expires_at)
    WHERE cleanup_at IS NULL;
