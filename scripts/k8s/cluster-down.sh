#!/usr/bin/env bash
# Borra UNICAMENTE el cluster de este proyecto. No toca clusters, volumenes ni
# imagenes ajenos.
set -euo pipefail

CLUSTER=whatsapp-lab
if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster delete "$CLUSTER"
else
  echo "El cluster '$CLUSTER' no existe."
fi
