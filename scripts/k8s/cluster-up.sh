#!/usr/bin/env bash
# Crea el cluster k3d del laboratorio. Idempotente: si ya existe, no hace nada.
set -euo pipefail

CLUSTER=whatsapp-lab
CONFIG="$(cd "$(dirname "$0")/../.." && pwd)/infra/k3d/cluster.yaml"

for tool in k3d kubectl docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "falta $tool en el PATH"; exit 1; }
done
docker ps >/dev/null 2>&1 || { echo "el daemon de Docker no responde"; exit 1; }

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "El cluster '$CLUSTER' ya existe."
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
else
  echo "Creando el cluster '$CLUSTER' (1 server + 2 agents)…"
  k3d cluster create --config "$CONFIG"
fi

kubectl config use-context "k3d-$CLUSTER" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=120s >/dev/null
echo
kubectl get nodes
