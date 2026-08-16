#!/usr/bin/env bash
# Corrida base de carga contra el Ingress.
#
#   npm run k6:base                 20 req/s durante 30s
#   RATE=50 DURATION=1m npm run k6:base
#
# Siembra primero y corre despues, siempre en ese orden: el escenario necesita que las
# conversaciones existan, y el seed es idempotente, asi que sembrar antes de cada
# corrida no cambia el estado si ya estaba. Eso es lo que hace comparables dos
# corridas separadas por horas.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${INGRESS_URL:-http://localhost:8081}"
CONVERSACIONES="${CONVERSACIONES:-10}"
DISPOSITIVOS="${DISPOSITIVOS:-4}"
SEED_FILE="${SEED_FILE:-$ROOT/infra/k6/seed.json}"

command -v k6 >/dev/null 2>&1 || { echo "falta k6 en el PATH (brew install k6)"; exit 1; }

curl -s -o /dev/null -m 5 "$BASE/health/ready" || {
  echo "El ingress no responde en $BASE. ¿Corriste 'npm run k8s:deploy'?"; exit 1; }

# El seed corre DESDE EL HOST contra la base del cluster, no como Job: necesitamos el
# JSON con los ids acá afuera para dárselo a k6. Por eso el port-forward temporal.
echo "Sembrando ${CONVERSACIONES}×${DISPOSITIVOS} y guardando los ids en $SEED_FILE…"
kubectl -n whatsapp-lab port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
trap 'kill $FORWARD_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  nc -z localhost 15432 2>/dev/null && break
  sleep 0.5
done

# --fresh es obligatorio acá, no una comodidad: sin el, la segunda corrida manda las
# mismas Idempotency-Key, recibe replays en vez de crear, y devuelve un p95 buenisimo
# que no mide el camino de escritura. Deja la poblacion y borra el trafico.
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" \
    --conversations="$CONVERSACIONES" --devices="$DISPOSITIVOS" --fresh --json \
  | sed -n '/^{/,$p' > "$SEED_FILE"

kill $FORWARD_PID 2>/dev/null || true
trap - EXIT

echo
k6 run \
  -e "INGRESS_URL=$BASE" \
  -e "SEED_FILE=$SEED_FILE" \
  ${RATE:+-e "RATE=$RATE"} \
  ${DURATION:+-e "DURATION=$DURATION"} \
  "$ROOT/infra/k6/escenario-base.js"
