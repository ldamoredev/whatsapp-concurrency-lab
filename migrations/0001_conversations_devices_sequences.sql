-- 0001 — Conversaciones, dispositivos y los dos contadores de orden.
--
-- Este slice crea estructura, no logica. Pero las constraints que hacen segura la
-- logica futura viven aca desde el principio: si la invariante depende de un `if`
-- en TypeScript, no es una invariante, es una intencion.
--
-- Hay DOS ordenes distintos en el sistema y no se pueden confundir:
--   · client_sequence  -> orden del stream de UN dispositivo emisor (device_sequences)
--   · server_sequence  -> orden visible de la conversacion       (conversation_sequences)
-- Ninguno se deriva de un timestamp. `created_at` existe para auditar, nunca para ordenar.

CREATE TABLE conversations (
    id         uuid        PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id         uuid        PRIMARY KEY,
    owner_id   uuid        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX devices_owner_id_idx ON devices (owner_id);


-- Membresia mutable: que dispositivos participan hoy de la conversacion.
--
-- IMPORTANTE: el destinatario de un mensaje NO se lee de aca en tiempo de entrega.
-- Al publicar se congela un snapshot (delivery_batches.expected_count + envelopes).
-- Esta tabla cambia; aquel snapshot no. Es lo que hace que `expected_count` no se
-- mueva cuando alguien agrega o quita un dispositivo despues de publicar.
CREATE TABLE conversation_devices (
    conversation_id uuid        NOT NULL REFERENCES conversations (id),
    device_id       uuid        NOT NULL REFERENCES devices (id),
    added_at        timestamptz NOT NULL DEFAULT now(),
    removed_at      timestamptz,

    -- RACE: dos requests concurrentes agregando el mismo dispositivo a la misma
    -- conversacion dejarian dos filas de membresia. El proximo snapshot contaria
    -- ese dispositivo dos veces y `expected_count` nunca se alcanzaria: los
    -- envelopes no se limpiarian jamas. La PK compuesta hace que el segundo INSERT
    -- falle con 23505 en vez de duplicar al destinatario.
    CONSTRAINT conversation_devices_pkey PRIMARY KEY (conversation_id, device_id)
);

CREATE INDEX conversation_devices_device_id_idx ON conversation_devices (device_id);


-- Contador de orden visible de la conversacion.
--
-- Una fila por conversacion, y esa fila es el punto de serializacion: al publicar
-- se toma `SELECT ... FOR UPDATE` sobre ella, se lee `next_server_sequence`, se
-- asigna al mensaje y se incrementa en la misma transaccion. `version` permite
-- ademas el update condicional (compare-and-set) donde se prefiera optimismo con
-- reintento en lugar de un lock pesimista; la eleccion se documenta por caso.
CREATE TABLE conversation_sequences (
    conversation_id      uuid   PRIMARY KEY REFERENCES conversations (id),
    next_server_sequence bigint NOT NULL DEFAULT 1,
    version              bigint NOT NULL DEFAULT 0,

    -- RACE (via la PK): dos filas de contador para la misma conversacion serian dos
    -- autoridades de orden. Cada una entregaria el mismo server_sequence a mensajes
    -- distintos y la unicidad de I5 fallaria recien al insertar el mensaje, cuando
    -- ya se hizo trabajo. Una sola fila = un solo lugar donde lockear.
    CONSTRAINT conversation_sequences_next_positive
        CHECK (next_server_sequence >= 1),
    CONSTRAINT conversation_sequences_version_non_negative
        CHECK (version >= 0)
);


-- Proximo client_sequence esperado por (conversacion, dispositivo), y estado de la
-- politica de huecos de ese stream.
--
--   ok              -> el stream esta al dia
--   waiting_gap     -> llego una secuencia mayor a la esperada; hay mensajes buffered
--                      y un deadline corriendo
--   resync_required -> el deadline vencio. NO se salta el hueco en silencio: el
--                      cliente tiene que preguntar cual es el proximo esperado.
--
-- Esta eleccion preserva orden y sacrifica disponibilidad de ese dispositivo. Es
-- deliberado: esperar para siempre tampoco es una solucion.
CREATE TABLE device_sequences (
    conversation_id      uuid        NOT NULL REFERENCES conversations (id),
    device_id            uuid        NOT NULL REFERENCES devices (id),
    next_client_sequence bigint      NOT NULL DEFAULT 1,
    state                text        NOT NULL DEFAULT 'ok',
    gap_deadline         timestamptz,

    -- RACE (via la PK): igual que arriba pero por stream. Dos filas para el mismo
    -- (conversacion, dispositivo) permitirian que dos requests concurrentes creyeran
    -- cada uno ser el proximo esperado y publicaran fuera de orden.
    CONSTRAINT device_sequences_pkey PRIMARY KEY (conversation_id, device_id),

    CONSTRAINT device_sequences_next_positive
        CHECK (next_client_sequence >= 1),
    CONSTRAINT device_sequences_state_valid
        CHECK (state IN ('ok', 'waiting_gap', 'resync_required')),

    -- Un hueco sin deadline es un hueco que espera para siempre; un deadline sin
    -- hueco es basura que un cleanup futuro interpretaria mal. El estado y su
    -- deadline se mueven juntos o no se mueven.
    CONSTRAINT device_sequences_gap_deadline_matches_state
        CHECK ((state = 'waiting_gap') = (gap_deadline IS NOT NULL))
);

-- Barrido del CronJob de expiracion: huecos vencidos que deben pasar a resync_required.
CREATE INDEX device_sequences_gap_deadline_idx
    ON device_sequences (gap_deadline)
    WHERE state = 'waiting_gap';


COMMENT ON TABLE conversation_devices IS
    'Membresia mutable. El destinatario de un mensaje publicado se congela en delivery_batches, no se lee de aca.';
COMMENT ON TABLE conversation_sequences IS
    'Autoridad del orden visible: una fila por conversacion, tomada con FOR UPDATE al publicar.';
COMMENT ON TABLE device_sequences IS
    'Orden del stream de un dispositivo emisor y estado de la politica de huecos.';
