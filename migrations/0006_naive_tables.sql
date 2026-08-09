-- 0006 — Tablas espejo SIN protecciones, para el panel de laboratorio.
--
-- Estas tablas existen para poder ejecutar, de verdad y contra PostgreSQL, la version
-- INGENUA de cada operacion: la que uno escribiria sin pensar en concurrencia.
--
-- Son deliberadamente inseguras. No tienen:
--   · UNIQUE (actor_id, route, key)                     -> sin I1
--   · UNIQUE (conversation_id, sender_device_id, seq)   -> sin I4
--   · UNIQUE (conversation_id, server_sequence)         -> sin I5
--   · PRIMARY KEY (message_id, device_id) en receipts   -> sin I8
--   · CHECK (delivered_count <= expected_count)         -> sin tope de progreso
--
-- Por que existen en vez de borrar las constraints reales y restaurarlas: borrar una
-- constraint de la tabla de produccion para una demo dejaria al sistema sin proteccion
-- durante la ventana en la que otro request podria estar corriendo, y una demo que
-- falla a la mitad dejaria el schema roto. Un espejo separado hace la misma
-- demostracion sin tocar jamas el camino real.
--
-- El panel las trunca en cada corrida. Ningun codigo de produccion las lee.

CREATE TABLE naive_operations (
    id          uuid        PRIMARY KEY,
    actor_id    uuid        NOT NULL,
    route       text        NOT NULL,
    key         text        NOT NULL,
    resource_id uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sin UNIQUE. La aplicacion "se protege" con un SELECT previo, que es exactamente el
-- bug: entre ese SELECT y este INSERT hay una ventana.
CREATE INDEX naive_operations_key_idx ON naive_operations (actor_id, route, key);


CREATE TABLE naive_messages (
    id               uuid        PRIMARY KEY,
    conversation_id  uuid        NOT NULL,
    sender_device_id uuid        NOT NULL,
    client_sequence  bigint      NOT NULL,
    server_sequence  bigint,
    body             text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Sin UNIQUE de stream ni de orden visible: dos mensajes pueden ocupar la misma
-- posicion, que es justamente lo que el panel muestra que pasa.
CREATE INDEX naive_messages_stream_idx
    ON naive_messages (conversation_id, sender_device_id, client_sequence);


CREATE TABLE naive_batches (
    message_id      uuid    PRIMARY KEY,
    expected_count  integer NOT NULL,
    -- Sin CHECK: puede pasarse de expected_count y nadie avisa.
    delivered_count integer NOT NULL DEFAULT 0
);


CREATE TABLE naive_receipts (
    id         uuid        PRIMARY KEY,
    message_id uuid        NOT NULL,
    device_id  uuid        NOT NULL,
    state      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Sin PRIMARY KEY (message_id, device_id): un dispositivo puede tener varios recibos.
CREATE INDEX naive_receipts_message_idx ON naive_receipts (message_id, device_id);


COMMENT ON TABLE naive_operations IS
    'Espejo SIN constraints para demostrar que pasa sin I1. No lo usa ningun camino real.';
COMMENT ON TABLE naive_messages IS
    'Espejo SIN constraints para demostrar que pasa sin I4 e I5.';
COMMENT ON TABLE naive_receipts IS
    'Espejo SIN constraints para demostrar que pasa sin I7 e I8.';
