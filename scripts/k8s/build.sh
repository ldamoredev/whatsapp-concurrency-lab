#!/usr/bin/env bash
# Construye la imagen y la importa al cluster. Idempotente.
#
# No hay registry: la imagen se importa, asi el artefacto que corre en el cluster es
# exactamente el que se construyo aca.
set -euo pipefail

CLUSTER=whatsapp-lab
TAG="${IMAGE_TAG:-v1}"
IMAGE="whatsapp-concurrency-lab:$TAG"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

k3d cluster list "$CLUSTER" >/dev/null 2>&1 || { echo "El cluster '$CLUSTER' no existe. Corré 'npm run cluster:up'."; exit 1; }

echo "Construyendo $IMAGE…"
docker build -t "$IMAGE" --target runtime "$ROOT"

echo "Importando al cluster…"
k3d image import "$IMAGE" --cluster "$CLUSTER"

echo
echo "Presente en los nodos:"
for node in $(k3d node list --no-headers | awk '/'"$CLUSTER"'-(server|agent)/ {print $1}'); do
  printf "  %-30s " "$node"
  docker exec "$node" crictl images 2>/dev/null | grep -c "whatsapp-concurrency-lab" || echo 0
done
