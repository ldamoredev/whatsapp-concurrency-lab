-- 0002 — Operaciones idempotentes.
--
-- La key NO vive en Redis ni en memoria del proceso. Una constraint unica durable
-- decide quien es el dueno de la operacion. Con tres replicas detras de un load
-- balancer sin sticky sessions, cualquier otra autoridad es una carrera esperando.

CREATE TABLE idempotency_operations (
    id              uuid        PRIMARY KEY,

    -- El scope de la key: (actor, ruta, key). La misma key de dos clientes distintos,
    -- o la misma key contra dos rutas distintas, son operaciones distintas.
    actor_id        uuid        NOT NULL,
    route           text        NOT NULL,
    key             text        NOT NULL,

    -- Hash canonico de todos los campos que definen el efecto. Distinguir "es el
    -- mismo pedido" de "es la misma key con otro cuerpo" (I2) depende de esto.
    fingerprint     text        NOT NULL,

    status          text        NOT NULL DEFAULT 'in_progress',
    recovery_point  text        NOT NULL DEFAULT 'started',

    -- Fencing token. Cada intento que toma el lease incrementa `attempt`; los updates
    -- finales verifican el valor que leyeron. Un owner viejo que revive despues de
    -- perder su lease no puede completar ni duplicar la operacion.
    attempt         integer     NOT NULL DEFAULT 1,

    -- Resultado reproducible. Si el commit ocurrio y la respuesta se perdio en la red,
    -- el retry lo lee de aca en vez de volver a ejecutar (I3).
    resource_id     uuid,
    response_status integer,
    response_body   jsonb,

    lease_until     timestamptz,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    ---------------------------------------------------------------------------
    -- I1 — una idempotency key compatible produce un solo efecto logico.
    --
    -- RACE: 100 requests concurrentes con la misma key llegan a tres pods distintos.
    -- Los 100 leen "no existe" (en READ COMMITTED nadie ve la fila no commiteada del
    -- otro) y los 100 intentan crear el mensaje. Sin esta constraint hay 100 mensajes.
    -- Con ella exactamente un INSERT gana; los otros 99 reciben 23505 y eso NO es un
    -- error para el cliente: es la senal de que hay que leer el resultado del dueno
    -- (replay) o responder IDEMPOTENCY_IN_PROGRESS.
    --
    -- Es una constraint, no un `if`: entre el SELECT y el INSERT de la aplicacion
    -- siempre hay una ventana. Aca no la hay.
    ---------------------------------------------------------------------------
    CONSTRAINT idempotency_operations_actor_route_key_uniq
        UNIQUE (actor_id, route, key),

    CONSTRAINT idempotency_operations_status_valid
        CHECK (status IN ('in_progress', 'completed', 'failed')),

    -- Los recovery points son un camino, no un conjunto:
    --   started -> message_persisted -> deliveries_created -> completed
    CONSTRAINT idempotency_operations_recovery_point_valid
        CHECK (recovery_point IN ('started', 'message_persisted', 'deliveries_created', 'completed')),

    CONSTRAINT idempotency_operations_attempt_positive
        CHECK (attempt >= 1),

    -- I3 — un retry completado devuelve el mismo messageId.
    -- Una operacion marcada `completed` sin respuesta persistida vuelve imposible
    -- cumplir I3: el retry no tendria nada que devolver y la aplicacion se veria
    -- tentada a re-ejecutar. Marcar completed y persistir el resultado son el mismo
    -- acto, y esta constraint lo obliga.
    CONSTRAINT idempotency_operations_completed_has_response
        CHECK (
            status <> 'completed'
            OR (response_status IS NOT NULL AND response_body IS NOT NULL AND recovery_point = 'completed')
        ),

    -- Simetrico: `completed` es el ultimo recovery point y nadie mas puede usarlo.
    CONSTRAINT idempotency_operations_recovery_point_matches_status
        CHECK (recovery_point <> 'completed' OR status = 'completed')
);

-- Recuperacion de operaciones abandonadas: cual tiene el lease vencido y sigue en curso.
CREATE INDEX idempotency_operations_stale_lease_idx
    ON idempotency_operations (lease_until)
    WHERE status = 'in_progress';

-- Barrido del CronJob de expiracion.
CREATE INDEX idempotency_operations_expires_at_idx
    ON idempotency_operations (expires_at);

-- Buscar la operacion que produjo un recurso, para tests de invariantes y recovery.
CREATE INDEX idempotency_operations_resource_id_idx
    ON idempotency_operations (resource_id)
    WHERE resource_id IS NOT NULL;


COMMENT ON TABLE idempotency_operations IS
    'Dueno durable de una idempotency key. La unicidad de (actor_id, route, key) es I1.';
COMMENT ON COLUMN idempotency_operations.attempt IS
    'Fencing token: impide que un owner que perdio el lease complete la operacion.';
