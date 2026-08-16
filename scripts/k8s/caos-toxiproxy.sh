#!/usr/bin/env bash
# Degrada la conexion API → PostgreSQL con Toxiproxy y mide el efecto.
#
#   npm run caos:toxiproxy                      latencia de 100ms
#   TOXIC=latency LATENCIA=250 npm run caos:toxiproxy
#   TOXIC=ninguno npm run caos:toxiproxy        control: proxy en el medio, sin toxic
#   TOXIC=reset_peer npm run caos:toxiproxy     corta conexiones establecidas
#
# TRES CORRIDAS, NO UNA. Comparar "sin proxy" contra "con proxy y latencia" mezcla dos
# cambios: el proxy y el toxic. Por eso existe TOXIC=ninguno — mide cuanto cuesta el
# proxy solo, y recien contra ESO se puede atribuir la diferencia a la latencia.
#
# El script deja el cluster como lo encontro: saca los toxics, devuelve el DATABASE_URL
# de la API a `postgres` y borra Toxiproxy. El camino normal del laboratorio no puede
# quedar con un proxy en el medio, porque cambiaria en silencio lo que miden todas las
# demas corridas.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"
TOXIC="${TOXIC:-latency}"
LATENCIA="${LATENCIA:-100}"
JITTER="${JITTER:-10}"
RATE="${RATE:-20}"
DURATION="${DURATION:-30s}"
CONVERSACIONES="${CONVERSACIONES:-10}"
DISPOSITIVOS="${DISPOSITIVOS:-4}"
SEED_FILE="$ROOT/infra/k6/seed.json"
LOG="$ROOT/infra/k6/caos-toxiproxy-$TOXIC.log"

URL_DIRECTA='postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)'
URL_PROXY='postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@toxiproxy:5432/$(POSTGRES_DB)'

command -v k6 >/dev/null 2>&1 || { echo "falta k6 en el PATH (brew install k6)"; exit 1; }
kubectl config current-context 2>/dev/null | grep -q "k3d-whatsapp-lab" || {
  echo "El contexto actual no es k3d-whatsapp-lab."; exit 1; }

restaurar() {
  echo
  echo "== Restaurando: la API vuelve a hablarle a Postgres directo =="
  kubectl -n "$NS" set env deployment/api "DATABASE_URL=$URL_DIRECTA" >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deployment/api --timeout=180s >/dev/null 2>&1 || true
  kubectl delete -f "$ROOT/infra/k8s/caos/toxiproxy.yaml" --ignore-not-found >/dev/null 2>&1 || true
  kill "${FORWARD_PID:-0}" "${ADMIN_PID:-0}" 2>/dev/null || true
  echo "  listo: $(kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_URL")].value}')"
}
trap restaurar EXIT

echo "== Levantando Toxiproxy =="
kubectl apply -f "$ROOT/infra/k8s/caos/toxiproxy.yaml" >/dev/null
kubectl -n "$NS" rollout status deployment/toxiproxy --timeout=180s

# El puerto de administracion, para crear el proxy y los toxics.
kubectl -n "$NS" port-forward svc/toxiproxy 8474:8474 >/dev/null 2>&1 &
ADMIN_PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null localhost:8474/version && break; sleep 0.5; done

echo
echo "== Creando el proxy 5432 → postgres:5432 =="
curl -s -X POST localhost:8474/proxies -H 'content-type: application/json' -d '{
  "name": "postgres",
  "listen": "0.0.0.0:5432",
  "upstream": "postgres:5432",
  "enabled": true
}' | head -c 200
echo

if [ "$TOXIC" != "ninguno" ]; then
  echo
  echo "== Agregando el toxic: $TOXIC =="
  case "$TOXIC" in
    latency)
      # `downstream` es el sentido base → API: la latencia se paga al RECIBIR la
      # respuesta, que es donde la sufre una query.
      curl -s -X POST localhost:8474/proxies/postgres/toxics -H 'content-type: application/json' \
        -d "{\"name\":\"lentitud\",\"type\":\"latency\",\"stream\":\"downstream\",\"toxicity\":1.0,
             \"attributes\":{\"latency\":$LATENCIA,\"jitter\":$JITTER}}" | head -c 300
      ;;
    reset_peer)
      # Corta la conexion establecida: el pool tiene que notarlo y reponerla.
      curl -s -X POST localhost:8474/proxies/postgres/toxics -H 'content-type: application/json' \
        -d '{"name":"corte","type":"reset_peer","stream":"downstream","toxicity":0.3,
             "attributes":{"timeout":0}}' | head -c 300
      ;;
    *) echo "TOXIC desconocido: $TOXIC"; exit 1 ;;
  esac
  echo
fi

echo
echo "== Mandando la API a traves del proxy =="
kubectl -n "$NS" set env deployment/api "DATABASE_URL=$URL_PROXY" >/dev/null
kubectl -n "$NS" rollout status deployment/api --timeout=300s

for _ in $(seq 1 60); do curl -s -o /dev/null -m 2 "$BASE/health/ready" && break; sleep 1; done

echo
echo "== Sembrando streams virgenes =="
kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && break; sleep 0.5; done
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" \
    --conversations="$CONVERSACIONES" --devices="$DISPOSITIVOS" --fresh --json \
  | sed -n '/^{/,$p' > "$SEED_FILE"

echo
echo "== Carga: $RATE req/s durante $DURATION, con toxic '$TOXIC' =="
k6 run -e "INGRESS_URL=$BASE" -e "SEED_FILE=$SEED_FILE" -e "RATE=$RATE" -e "DURATION=$DURATION" \
  "$ROOT/infra/k6/escenario-base.js" > "$LOG" 2>&1 || true
grep -E "p\(95\)|p\(90\)|http_req_failed\.|lab_mensajes_creados|checks_succeeded" "$LOG" | sed 's/^/  /'

echo
echo "== I1..I10 contra la base =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts"
