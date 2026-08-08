-- 0004 — Entrega: snapshot, trabajo pendiente y recibo durable.
--
-- Tres tablas, tres vidas distintas. Esta separacion es el corazon del diseno:
--
--   delivery_batches    snapshot inmutable de a cuantos hay que entregar.
--                       Se crea una vez al publicar y sobrevive para siempre.
--   delivery_envelopes  trabajo pendiente, uno por dispositivo. SE BORRA en el
--                       cleanup cuando todos llegaron al estado terminal.
--   delivery_receipts   estado durable por dispositivo. NO se borra nunca: es la
--                       evidencia con la que se auditan I7, I8 y I9 despues de que
--                       los envelopes desaparecieron.
--
-- Colapsar esto en una fila (por ejemplo, un `delivered_at` en `messages` o un estado
-- en el envelope que hiciera de recibo) romperia dos cosas a la vez: el cleanup
-- borraria la evidencia, y cada ack de cada dispositivo competiria por la MISMA fila
-- que todos los demas.

CREATE TABLE delivery_batches (
    -- PK = message_id. Un mensaje tiene exactamente un batch.
    --
    -- RACE: dos owners concurrentes de la misma idempotency key (o un retry que
    -- reejecuta el paso `deliveries_created`) crearian dos snapshots del mismo
    -- mensaje, con dos expected_count y dos progresos independientes. El cleanup
    -- miraria uno y borraria envelopes que el otro todavia espera. La PK convierte
    -- ese "crear el batch" en una operacion naturalmente reentrante: el segundo
    -- intento choca con 23505 y sabe que el trabajo ya estaba hecho.
    message_id      uuid        PRIMARY KEY,

    -- Congelado al publicar. Agregar o quitar un dispositivo despues NO lo mueve.
    expected_count  integer     NOT NULL,
    delivered_count integer     NOT NULL DEFAULT 0,

    completed_at    timestamptz,
    cleanup_at      timestamptz,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT delivery_batches_message_fkey
        FOREIGN KEY (message_id) REFERENCES messages (id),

    CONSTRAINT delivery_batches_expected_count_positive
        CHECK (expected_count >= 1),
    CONSTRAINT delivery_batches_delivered_count_non_negative
        CHECK (delivered_count >= 0),

    -- I8 — un ack duplicado no incrementa dos veces el progreso.
    --
    -- RACE: tres dispositivos ackean a la vez, cada uno varias veces por reintento.
    -- Si el incremento no fuera condicional (solo cuando el receipt realmente cambia
    -- de estado), delivered_count pasaria expected_count y el batch se daria por
    -- completo con dispositivos todavia pendientes.
    --
    -- El CHECK no implementa la idempotencia — eso es el update condicional sobre
    -- delivery_receipts — pero convierte el bug en un error inmediato y ruidoso
    -- (23514) en vez de un cleanup silencioso y prematuro.
    CONSTRAINT delivery_batches_delivered_not_above_expected
        CHECK (delivered_count <= expected_count),

    -- I9 — no se limpian envelopes mientras quede un dispositivo esperado pendiente.
    -- Un cleanup sin completion es exactamente el bug que I9 prohibe.
    CONSTRAINT delivery_batches_cleanup_requires_completion
        CHECK (cleanup_at IS NULL OR completed_at IS NOT NULL),

    -- Coherencia del snapshot: si se declaro completo, el progreso tiene que estar
    -- realmente completo. Impide marcar completed_at "por las dudas".
    CONSTRAINT delivery_batches_completed_requires_full_progress
        CHECK (completed_at IS NULL OR delivered_count = expected_count)
);

-- I10 — el cleanup final ocurre una sola vez: buscar los batches completos que
-- todavia no se limpiaron, y los vencidos por TTL.
CREATE INDEX delivery_batches_pending_cleanup_idx
    ON delivery_batches (completed_at)
    WHERE cleanup_at IS NULL;

CREATE INDEX delivery_batches_expires_at_idx
    ON delivery_batches (expires_at)
    WHERE cleanup_at IS NULL;


-- Trabajo pendiente: una unidad de entrega por (mensaje, dispositivo).
--
-- Tiene id propio y no PK compuesta, a proposito: es una entidad efimera con ciclo
-- de vida distinto al del recibo. Se borra. El recibo no.
CREATE TABLE delivery_envelopes (
    id         uuid        PRIMARY KEY,

    -- La FK apunta a delivery_batches, no a messages: no puede existir trabajo de
    -- entrega sin el snapshot que dice cuanto trabajo es. ON DELETE RESTRICT porque
    -- el cleanup borra envelopes, nunca el batch.
    message_id uuid        NOT NULL,
    device_id  uuid        NOT NULL,
    state      text        NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT delivery_envelopes_batch_fkey
        FOREIGN KEY (message_id) REFERENCES delivery_batches (message_id) ON DELETE RESTRICT,
    CONSTRAINT delivery_envelopes_device_fkey
        FOREIGN KEY (device_id) REFERENCES devices (id),

    -- RACE: un retry que reejecuta el paso `deliveries_created` insertaria un segundo
    -- envelope para el mismo dispositivo. Ese dispositivo recibiria el mensaje dos
    -- veces, y el cleanup contaria mal el trabajo restante. C1 exige explicitamente
    -- "ninguna delivery duplicada"; esta es la constraint que lo garantiza.
    CONSTRAINT delivery_envelopes_message_device_uniq
        UNIQUE (message_id, device_id),

    CONSTRAINT delivery_envelopes_state_valid
        CHECK (state IN ('pending', 'delivered'))
);

CREATE INDEX delivery_envelopes_pending_idx
    ON delivery_envelopes (message_id)
    WHERE state = 'pending';

CREATE INDEX delivery_envelopes_device_idx
    ON delivery_envelopes (device_id, created_at);


-- Recibo durable por dispositivo. Sobrevive al cleanup del envelope.
CREATE TABLE delivery_receipts (
    -- PK compuesta (mensaje, dispositivo): un solo recibo por dispositivo.
    --
    -- RACE: dos acks concurrentes del mismo dispositivo llegan a dos replicas. Sin
    -- esta PK cada una insertaria su propio recibo; el batch contaria dos progresos
    -- para un solo destinatario (I8) y el estado del dispositivo dejaria de tener una
    -- respuesta unica. Con ella, el segundo INSERT choca con 23505 y el camino
    -- correcto es el update condicional sobre la fila que ya existe.
    message_id   uuid        NOT NULL,
    device_id    uuid        NOT NULL,

    state        text        NOT NULL DEFAULT 'pending',
    delivered_at timestamptz,
    read_at      timestamptz,

    -- I7 — un receipt nunca retrocede.
    --
    -- La monotonicidad se impone con un UPDATE condicional que exige la version leida
    -- (`WHERE version = $n`) y solo avanza estados: un ack `delivered` que llega tarde,
    -- despues de un `read`, actualiza 0 filas y se responde como idempotente.
    -- Postgres no puede expresar "el nuevo valor debe ser >= el viejo" en un CHECK,
    -- porque un CHECK no ve la fila anterior. Lo que si se puede garantizar en el
    -- schema es que ningun estado incoherente exista, y de eso se ocupa el CHECK de
    -- abajo. La regresion se prueba en el test de integracion del slice 4.
    version      bigint      NOT NULL DEFAULT 0,

    CONSTRAINT delivery_receipts_pkey PRIMARY KEY (message_id, device_id),

    -- ON DELETE RESTRICT: el recibo sobrevive al cleanup del envelope, y el batch no
    -- se puede borrar mientras exista evidencia colgando de el.
    CONSTRAINT delivery_receipts_batch_fkey
        FOREIGN KEY (message_id) REFERENCES delivery_batches (message_id) ON DELETE RESTRICT,
    CONSTRAINT delivery_receipts_device_fkey
        FOREIGN KEY (device_id) REFERENCES devices (id),

    CONSTRAINT delivery_receipts_state_valid
        CHECK (state IN ('pending', 'delivered', 'read')),
    CONSTRAINT delivery_receipts_version_non_negative
        CHECK (version >= 0),

    -- Los timestamps son parte del estado, no decoracion. Un recibo `read` sin
    -- `delivered_at` significaria que el dispositivo leyo un mensaje que nunca le
    -- llego: el estado habria saltado pending -> read sin pasar por delivered.
    -- El CHECK vuelve imposible representar esa historia.
    --
    -- Como en messages, se escribe con igualdades de booleanos para que este CHECK
    -- solo opine sobre la coherencia estado <-> timestamps: un state fuera del dominio
    -- es responsabilidad exclusiva de `delivery_receipts_state_valid`.
    CONSTRAINT delivery_receipts_state_matches_timestamps
        CHECK (
            (delivered_at IS NOT NULL) = (state IN ('delivered', 'read'))
            AND (read_at IS NOT NULL) = (state = 'read')
        )
);

-- Auditar I9 despues del cleanup: cuantos dispositivos del snapshot llegaron al
-- estado terminal, cuando los envelopes ya no existen.
CREATE INDEX delivery_receipts_message_state_idx
    ON delivery_receipts (message_id, state);


COMMENT ON TABLE delivery_batches IS
    'Snapshot inmutable de destinatarios al publicar. expected_count no cambia si despues se agrega o quita un dispositivo.';
COMMENT ON TABLE delivery_envelopes IS
    'Trabajo pendiente por dispositivo. Se BORRA en el cleanup. No es el recibo.';
COMMENT ON TABLE delivery_receipts IS
    'Estado durable por dispositivo. Sobrevive al cleanup del envelope para poder auditar las invariantes.';
