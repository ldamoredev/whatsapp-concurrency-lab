-- 0003 — Mensaje logico.
--
-- El mensaje es UNA fila: identidad unica e inmutable. No lleva estado de entrega,
-- no lleva contadores de acks y no sabe cuantos dispositivos lo esperan. Todo eso
-- vive en 0004. Si esa informacion se colara aca, idempotencia, multi-device y
-- cleanup quedarian mezclados en la misma fila y cada ack seria una carrera sobre
-- el mensaje mismo.

CREATE TABLE messages (
    id                uuid        PRIMARY KEY,

    -- Id generado por el cliente. Sirve para deteccion de replay a nivel de stream,
    -- independiente de la idempotency key de transporte.
    client_message_id text        NOT NULL,

    conversation_id   uuid        NOT NULL,
    sender_id         uuid        NOT NULL,
    sender_device_id  uuid        NOT NULL,

    -- Orden del stream del emisor. Lo elige el cliente.
    client_sequence   bigint      NOT NULL,

    -- Orden visible de la conversacion. NULL mientras el mensaje esta buffered: un
    -- mensaje con un hueco adelante todavia no tiene lugar en la conversacion (I6).
    server_sequence   bigint,

    status            text        NOT NULL DEFAULT 'buffered',
    body              text        NOT NULL,

    -- Auditoria. NUNCA se usa para ordenar: el reloj del servidor no es confiable
    -- entre tres replicas.
    created_at        timestamptz NOT NULL DEFAULT now(),

    -- El emisor tiene que ser un dispositivo de esa conversacion. Es una FK compuesta,
    -- no un chequeo en la aplicacion: entre "verifique que pertenece" y "inserte el
    -- mensaje" hay una ventana en la que la membresia pudo cambiar.
    --
    -- Es la UNICA FK de conversacion a proposito: una FK adicional a conversations(id)
    -- seria redundante (conversation_devices ya la tiene) y volveria no determinista
    -- cual de las dos rechaza un insert invalido, que es justo lo que los tests
    -- necesitan afirmar con precision.
    CONSTRAINT messages_sender_membership_fkey
        FOREIGN KEY (conversation_id, sender_device_id)
        REFERENCES conversation_devices (conversation_id, device_id),

    CONSTRAINT messages_status_valid
        CHECK (status IN ('buffered', 'published')),

    CONSTRAINT messages_client_sequence_positive
        CHECK (client_sequence >= 1),
    CONSTRAINT messages_server_sequence_positive
        CHECK (server_sequence IS NULL OR server_sequence >= 1),

    -- I6 — un mensaje con hueco no se vuelve visible antes que sus predecesores.
    --
    -- El estado y el orden visible son la misma decision, tomada una sola vez: no se
    -- puede estar publicado sin lugar en la conversacion, ni tener lugar sin estar
    -- publicado. Sin esto, un bug de dos pasos ("marco published, despues asigno
    -- server_sequence") dejaria una ventana en la que el mensaje es visible sin orden.
    --
    -- Escrito como igualdad de dos booleanos y no como un OR de casos: asi este CHECK
    -- solo opina sobre el acoplamiento estado <-> orden, y un status fuera del dominio
    -- lo rechaza `messages_status_valid` y nadie mas. Cada constraint falla por su
    -- propio motivo, que es lo que permite que un test afirme cual fallo.
    CONSTRAINT messages_published_iff_server_sequence
        CHECK ((status = 'published') = (server_sequence IS NOT NULL))
);


---------------------------------------------------------------------------------
-- I4 — no hay dos mensajes para el mismo stream y client_sequence.
--
-- RACE: el cliente manda, pierde la respuesta por mala senal y reintenta contra
-- OTRA replica. Las dos requests pueden estar en vuelo a la vez. Si ademas la
-- idempotency key se genero de nuevo en el retry, I1 no las une: son operaciones
-- distintas para el mismo hecho. Esta constraint es la segunda linea de defensa y
-- la que ata la unicidad al dominio en lugar de al transporte: un dispositivo no
-- puede ocupar dos veces la misma posicion de su propio stream.
---------------------------------------------------------------------------------
CREATE UNIQUE INDEX messages_stream_client_sequence_uniq
    ON messages (conversation_id, sender_device_id, client_sequence);


---------------------------------------------------------------------------------
-- I5 — server_sequence es unica dentro de la conversacion, una vez publicada.
--
-- RACE: dos mensajes se publican a la vez en la misma conversacion. Ambos leyeron
-- `next_server_sequence = 7` antes de que el otro commiteara e intentan ocupar el 7.
-- Sin esta constraint quedan dos mensajes en la misma posicion y el orden visible
-- deja de ser un orden. Con ella, el segundo INSERT/UPDATE falla con 23505 y la
-- transaccion reintenta leyendo el contador de nuevo.
--
-- El indice es PARCIAL a proposito: `WHERE server_sequence IS NOT NULL`. Los mensajes
-- buffered todavia no compiten por una posicion y tienen que poder convivir de a
-- muchos. En Postgres los NULL no colisionan entre si en un indice unico comun, asi
-- que el parcial no es estrictamente necesario para la correccion — se usa igual
-- porque hace explicito en el schema que la regla aplica solo a lo publicado, y
-- mantiene el indice chico.
---------------------------------------------------------------------------------
CREATE UNIQUE INDEX messages_conversation_server_sequence_uniq
    ON messages (conversation_id, server_sequence)
    WHERE server_sequence IS NOT NULL;


-- Replay a nivel de stream: el mismo client_message_id reenviado por el mismo
-- dispositivo es el mismo mensaje, no uno nuevo. El scope es (conversacion,
-- dispositivo emisor): dos dispositivos pueden elegir el mismo id local sin chocar.
CREATE UNIQUE INDEX messages_client_message_id_uniq
    ON messages (conversation_id, sender_device_id, client_message_id);


-- Leer la conversacion en orden visible, y encontrar el proximo hueco a drenar.
CREATE INDEX messages_conversation_published_idx
    ON messages (conversation_id, server_sequence)
    WHERE status = 'published';

CREATE INDEX messages_buffered_stream_idx
    ON messages (conversation_id, sender_device_id, client_sequence)
    WHERE status = 'buffered';


COMMENT ON TABLE messages IS
    'Mensaje logico: identidad unica e inmutable. No lleva estado de entrega ni contadores de ack.';
COMMENT ON COLUMN messages.server_sequence IS
    'Orden visible. NULL mientras esta buffered: un mensaje con hueco adelante no tiene lugar todavia.';
COMMENT ON COLUMN messages.created_at IS
    'Solo auditoria. El orden no se decide con el reloj del servidor.';
