#!/usr/bin/env bash
# Corre el seed DENTRO del cluster, como Job, con la misma imagen que la API.
#
#   npm run k8s:seed                    5 conversaciones × 3 dispositivos
#   npm run k8s:seed -- 100 4           100 × 4
#   npm run k8s:seed -- 100 4 carga2    …con otro prefijo, disjunto del anterior
#
# El manifest se arma acá y no vive en infra/k8s/base/ a proposito: todo lo que hay
# en base lo aplica `deploy.sh` en CADA despliegue, y sembrar datos no es algo que
# deba pasar sola cada vez que se actualiza la API. Esto es una tarea a pedido.
#
# Es un Job y no un `kubectl exec` contra un pod de la API por dos razones: el pod de
# la API puede morir a mitad, y su etiqueta ya tiene permiso de red — un `exec` no
# probaria que el seed puede llegar a la base por sus propios medios.
set -euo pipefail

NS=whatsapp-lab
CONVERSATIONS="${1:-5}"
DEVICES="${2:-3}"
PREFIX="${3:-lab}"

kubectl config current-context 2>/dev/null | grep -q "k3d-whatsapp-lab" || {
  echo "El contexto actual no es k3d-whatsapp-lab. Corré 'npm run cluster:up'."; exit 1; }

# Un Job es inmutable una vez creado: para volver a correrlo hay que borrarlo. El seed
# es idempotente, asi que reejecutarlo no duplica nada.
kubectl -n "$NS" delete job seed --ignore-not-found >/dev/null

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: seed
  namespace: $NS
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        # ESTA ETIQUETA NO ES DECORATIVA: la NetworkPolicy de 60-networkpolicy.yaml
        # deja hablar con Postgres solo a un conjunto de etiquetas. Sin 'app: seed'
        # ahi, este Job recibe ECONNREFUSED y parece un problema de la base.
        app: seed
    spec:
      restartPolicy: OnFailure
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: seed
          image: whatsapp-concurrency-lab:v1
          imagePullPolicy: IfNotPresent
          command: ['node', 'dist/scripts/seed.js']
          args:
            - '--conversations=$CONVERSATIONS'
            - '--devices=$DEVICES'
            - '--prefix=$PREFIX'
          # ORDEN IMPORTANTE: ver el comentario de 20-migrate-job.yaml.
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef: { name: lab-postgres, key: POSTGRES_USER }
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: lab-postgres, key: POSTGRES_PASSWORD }
            - name: POSTGRES_DB
              valueFrom:
                configMapKeyRef: { name: lab-config, key: POSTGRES_DB }
            - name: DATABASE_URL
              value: postgres://\$(POSTGRES_USER):\$(POSTGRES_PASSWORD)@postgres:5432/\$(POSTGRES_DB)
            - name: DATABASE_POOL_MAX
              value: '2'
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ['ALL']
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
EOF

kubectl -n "$NS" wait --for=condition=complete job/seed --timeout=180s
echo
kubectl -n "$NS" logs job/seed | grep -v "injected env"
