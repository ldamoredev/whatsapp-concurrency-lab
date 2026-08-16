#!/usr/bin/env bash
# L3 — PostgreSQL lento, y despues cortando conexiones.
#
#   npm run caos:l3
#
# ALCANCE pide las dos fallas en secuencia sobre una carga menor y estable, y despues
# retirar el fallo. Los criterios de aprobacion no son de latencia:
#
#   · la API rechaza o vence por timeout ACOTADO, no acumula trabajo infinito;
#   · liveness NO reinicia todos los pods por una dependencia compartida;
#   · al retirar el fallo recupera SIN restart manual;
#   · los retries no multiplican la carga sin limite;
#   · las invariantes siguen en cero.
#
# El de liveness es el que mas facil se rompe en un diseño distraido: si la probe de
# liveness consultara la base, una base lenta reiniciaria las TRES replicas a la vez y
# convertiria una degradacion en una caida total. Acá liveness no toca la base a
# proposito, y esta corrida es la que lo demuestra: los RESTARTS tienen que quedar en 0.
#
# Fases, sobre una corrida de 4 minutos:
#   0:00  carga limpia a traves del proxy, sin toxic  (linea de base con proxy)
#   0:45  +100ms de latencia
#   1:45  se saca la latencia, se cortan conexiones (reset_peer)
#   2:45  se sacan TODOS los toxics  -> a partir de acá se mide la recuperacion
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"
RATE="${RATE:-20}"
DURATION="${DURATION:-4m}"
LATENCIA="${LATENCIA:-100}"
LOG="$ROOT/infra/k6/l3.log"

URL_DIRECTA='postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)'
URL_PROXY='postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@toxiproxy:5432/$(POSTGRES_DB)'

restaurar() {
  echo
  echo "== Restaurando =="
  kubectl -n "$NS" set env deployment/api "DATABASE_URL=$URL_DIRECTA" >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deployment/api --timeout=180s >/dev/null 2>&1 || true
  kubectl delete -f "$ROOT/infra/k8s/caos/toxiproxy.yaml" --ignore-not-found >/dev/null 2>&1 || true
  kill "${FORWARD_PID:-0}" "${ADMIN_PID:-0}" 2>/dev/null || true
}
trap restaurar EXIT

echo "== Levantando Toxiproxy y mandando la API a traves de el =="
kubectl apply -f "$ROOT/infra/k8s/caos/toxiproxy.yaml" >/dev/null
kubectl -n "$NS" rollout status deployment/toxiproxy --timeout=180s >/dev/null

kubectl -n "$NS" port-forward svc/toxiproxy 8474:8474 >/dev/null 2>&1 &
ADMIN_PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null localhost:8474/version && break; sleep 0.5; done

curl -s -X POST localhost:8474/proxies -H 'content-type: application/json' \
  -d '{"name":"postgres","listen":"0.0.0.0:5432","upstream":"postgres:5432","enabled":true}' >/dev/null

kubectl -n "$NS" set env deployment/api "DATABASE_URL=$URL_PROXY" >/dev/null
kubectl -n "$NS" rollout status deployment/api --timeout=300s
for _ in $(seq 1 60); do curl -s -o /dev/null -m 2 "$BASE/health/ready" && break; sleep 1; done

echo
echo "== Restarts ANTES (tienen que seguir igual al final) =="
kubectl -n "$NS" get pods -l app=api -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount' --no-headers | sed 's/^/  /'

echo
echo "== Sembrando =="
kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && break; sleep 0.5; done
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" --conversations=20 --devices=4 --hot-devices=40 --fresh --json \
  | sed -n '/^{/,$p' > "$ROOT/infra/k6/seed.json"

echo
echo "== Carga $RATE/s durante $DURATION, con las fases de falla =="
date -u +"  t0 = %H:%M:%SZ"
k6 run -e "INGRESS_URL=$BASE" -e "SEED_FILE=$ROOT/infra/k6/seed.json" \
  -e "RATE=$RATE" -e "DURATION=$DURATION" "$ROOT/infra/k6/escenario-l1.js" > "$LOG" 2>&1 &
K6_PID=$!

sleep 45
echo "  [$(date -u +%H:%M:%SZ)] +latencia ${LATENCIA}ms"
curl -s -X POST localhost:8474/proxies/postgres/toxics -H 'content-type: application/json' \
  -d "{\"name\":\"lentitud\",\"type\":\"latency\",\"stream\":\"downstream\",\"toxicity\":1.0,
       \"attributes\":{\"latency\":$LATENCIA,\"jitter\":10}}" >/dev/null

sleep 60
echo "  [$(date -u +%H:%M:%SZ)] -latencia, +corte de conexiones (reset_peer)"
curl -s -X DELETE localhost:8474/proxies/postgres/toxics/lentitud >/dev/null
curl -s -X POST localhost:8474/proxies/postgres/toxics -H 'content-type: application/json' \
  -d '{"name":"corte","type":"reset_peer","stream":"downstream","toxicity":0.4,
       "attributes":{"timeout":0}}' >/dev/null

sleep 60
echo "  [$(date -u +%H:%M:%SZ)] se retira TODO el fallo — desde acá se mide la recuperacion"
curl -s -X DELETE localhost:8474/proxies/postgres/toxics/corte >/dev/null

wait $K6_PID || true
date -u +"  tf = %H:%M:%SZ"

# Se captura ACA, antes de que el trap restaure: restaurar cambia el DATABASE_URL y
# eso dispara un rollout que reemplaza los pods. Leer los restarts despues seria leer
# los de pods recien nacidos, que siempre dan 0 y no prueban nada.
RESTARTS_FINALES=$(kubectl -n "$NS" get pods -l app=api \
  -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,READY:.status.containerStatuses[0].ready' --no-headers)

echo
echo "== Resultado =="
grep -E "✓|✗|p\(95\)|p\(99\)|l1_tasa|dropped_iterations|checks_succeeded|l1_duracion" "$LOG" | sed 's/^/  /'

echo
echo "== Restarts DESPUES — liveness no tiene que haber reiniciado nada =="
printf '%s\n' "$RESTARTS_FINALES" | sed 's/^/  /'

echo
echo "== Invariantes =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts" 2>&1 | grep -vE "injected env" | tail -3
