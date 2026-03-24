# 部署指南

## Docker

```bash
docker build -t gitea-assistant .
docker run -d -p 5174:5174 -v ./data:/app/data -e PORT=5174 gitea-assistant
```

## Docker Compose

```bash
docker compose up -d
```

`docker-compose.yml` 默认包含：

- `gitea-assistant`
- `qdrant`

如果不使用记忆能力，可在自定义编排中将 Qdrant 设为可选。

## Kubernetes

Kubernetes 清单位于 `k8s/` 目录。

### 1) 创建命名空间与加密密钥

```bash
kubectl apply -f k8s/namespace.yaml
ENCRYPTION_KEY=$(openssl rand -hex 32)
kubectl -n gitea-assistant create secret generic gitea-assistant-secret \
  --from-literal=ENCRYPTION_KEY=$ENCRYPTION_KEY
```

### 2) 部署

```bash
kubectl apply -k k8s/
```

或逐个应用：

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/qdrant.yaml
kubectl apply -f k8s/gitea-assistant.yaml
```

### 3) 验证

```bash
kubectl -n gitea-assistant get pods
kubectl -n gitea-assistant get svc
```

### 4) 对外暴露（可选）

```bash
kubectl -n gitea-assistant patch svc gitea-assistant -p '{"spec":{"type":"NodePort"}}'
```
