# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primario:** el autor del laboratorio (backend developer, español rioplatense), en dos
situaciones distintas:

1. **Aprendiendo, solo.** Recorre los escenarios para entender idempotencia, orden por
   conversación y concurrencia sobre estado compartido. *(inferido — evidencia: pidió
   explicaciones "más tangibles, tipo cinco años" de la idempotency key, y dijo "al no
   verlo reproduciendo no logro terminar de afianzar el concepto")*
2. **Mostrándolo, frente a alguien técnico.** El proyecto nació para responder un feedback
   de entrevista sobre concurrencia e idempotencia. *(confirmado — docs/ALCANCE.md)*

**Nivel asumido:** sabe programar backend, lee SQL, entiende transacciones básicas. **No**
domina idempotencia distribuida, relojes lógicos ni políticas de huecos. *(inferido)*

## Product Purpose

Un laboratorio que **demuestra**, no que simula: que un cliente puede perder una respuesta y
reintentar contra otra réplica, que varios dispositivos pueden confirmar al mismo tiempo, y
que aun así se crea un solo mensaje lógico, el estado sólo avanza y el orden se conserva.

El panel web existe para hacer **visibles** esas carreras. Éxito = alguien que no sabía qué
era una idempotency key la entiende después de usarlo, y alguien que sí sabía queda
convencido de que las garantías son reales.

## Positioning

No es un clon de WhatsApp ni una demo de chat. Es un banco de pruebas donde **la corrección
vive en la base de datos** —constraints, transacciones, locks y updates condicionales— y no
en la memoria de un proceso. Tres réplicas sin estado compartido lo hacen inevitable.

Lo que ningún tutorial de idempotencia copia: cada afirmación se verifica **consultando la
base al final**, no contando respuestas 2xx.

## Operating Context

- Se levanta con `npm run stack:up`: PostgreSQL, un job de migraciones y **tres réplicas**
  de la API en `:3001`, `:3002`, `:3003`.
- El panel se sirve desde la propia API; las tres réplicas sirven la misma página.
- Los escenarios se disparan **desde el navegador**, repartiendo requests entre las tres
  réplicas. Orquestarlos del lado servidor anularía la demostración.
- Uso en escritorio, localhost, sesión corta y deliberada (abrir, disparar, leer, cerrar).
- Existen además cuatro demos narradas en consola que cuentan lo mismo paso a paso.

## Capabilities and Constraints

**Escenarios disponibles:** carrera de idempotencia (100 requests concurrentes con la misma
key), key reusada con cuerpos distintos, orden y huecos (1, 3, 4 → 2), hueco que vence y
bloquea el stream, acks multi-dispositivo con el CronJob compitiendo, y carga sostenida.

**Verificación en vivo:** I4, I5, I8 e I9 se consultan contra la base y se muestran
permanentemente. Debe decir siempre "sin violaciones".

**Constraints técnicos confirmados:**
- Sin framework y **sin build step**: HTML, CSS y JS planos servidos por la API. El proyecto
  se explica leyendo el código; una capa de herramientas sería una capa más que explicar.
- No agregar dependencias que no resuelvan una necesidad del alcance.
- `POST /lab/reset` trunca la base: es la funcionalidad, no un riesgo. Se apaga con
  `LAB_PANEL_ENABLED=false`.
- Las réplicas están hardcodeadas hasta que llegue Traefik con k3d.
- Idioma: **español rioplatense**, incluido el panel.

## Brand Commitments

- Nombre: `whatsapp-concurrency-lab`.
- Voz: precisa y sin marketing. Nombra las cosas por su nombre técnico y explica el porqué.
  Admite límites en voz alta ("esto no demuestra HA de la base").
- Vocabulario fijo del dominio: idempotency key, fingerprint, lease, fencing, `buffered`,
  `resync_required`, envelope, receipt, snapshot, cleanup.

## Evidence on Hand

Todo lo que el panel muestra sale de corridas reales, no de datos inventados:

- `docs/ALCANCE.md` — alcance completo, fuente de verdad.
- `docs/adr/0001-0003` — decisiones que cambian una garantía.
- 171 tests: `test/unit`, `test/integration`, `test/e2e`.
- Corridas verificadas: C1 → `201 creado 1 · 200 replay 91 · 409 en curso 8`, repartidos
  34/33/33. C4 → `15 acks + 4 CronJobs → avanzaron 3 · sin efecto 12 · cleanups 1`.
- Verificación por mutación documentada en README: borrar una constraint hace fallar su test.

**No existe y no se debe fabricar:** datos de carga sostenida (k6), métricas de Kubernetes,
tiempos de recuperación ante pod kill, ni comparación con otros sistemas.

## Product Principles

1. **Mostrar la base, no la respuesta HTTP.** Contar 2xx no demuestra ninguna invariante;
   toda afirmación se respalda con una consulta.
2. **La carrera tiene que ser real.** Los requests salen del navegador hacia tres réplicas
   distintas. Nada simulado.
3. **Predecir antes de ejecutar.** El usuario debe saber qué espera ver *antes* de apretar,
   o el resultado no le enseña nada.
4. **Nombrar el mecanismo.** No alcanza con que funcione: hay que mostrar *qué* lo garantiza
   (la constraint, el lock, el update condicional) y qué pasaría sin eso.
5. **Admitir los límites.** Lo que el laboratorio no demuestra se dice explícitamente.

## Accessibility & Inclusion

- Debe funcionar en claro y oscuro.
- El estado nunca se comunica sólo por color: siempre hay texto o forma que lo acompañe.
- Contenido en español; los términos técnicos se mantienen en su forma original y se explican
  la primera vez.
