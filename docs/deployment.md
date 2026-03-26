# Deployment

## Docker

```bash
docker build -t gitea-assistant .
docker run -d -p 5174:5174 -v ./data:/app/data -e PORT=5174 -e LOG_LEVEL=error gitea-assistant
```

## Docker Compose

```bash
docker compose up -d
```

`docker-compose.yml` includes both:

- `gitea-assistant`
- `qdrant`

Production default in compose sets `LOG_LEVEL=error`.

If you do not use memory features, Qdrant can be optional in custom compose setups.

## Kubernetes

Kubernetes manifests are in `k8s/`.
The default ConfigMap sets `LOG_LEVEL=error` for production.

### 1) Create namespace and encryption secret

```bash
kubectl apply -f k8s/namespace.yaml
ENCRYPTION_KEY=$(openssl rand -hex 32)
kubectl -n gitea-assistant create secret generic gitea-assistant-secret \
  --from-literal=ENCRYPTION_KEY=$ENCRYPTION_KEY
```

### 2) Deploy

```bash
kubectl apply -k k8s/
```

Or apply individually:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/qdrant.yaml
kubectl apply -f k8s/gitea-assistant.yaml
```

### 3) Verify

```bash
kubectl -n gitea-assistant get pods
kubectl -n gitea-assistant get svc
```

### 4) Expose service (optional)

```bash
kubectl -n gitea-assistant patch svc gitea-assistant -p '{"spec":{"type":"NodePort"}}'
```
