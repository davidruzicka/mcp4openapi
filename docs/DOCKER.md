# Docker Deployment Guide

Run MCP from OpenAPI server in an isolated Docker container.

## Quick Start

### 1. Build Image

```bash
docker build -t mcp4openapi .
```

### 2. Choose Authentication Mode

**Single-user mode** (simple, one token for all):
```bash
cp .env.docker.example .env.docker
# Edit .env.docker with API_TOKEN
```

**Multi-user mode** (each user sends own token):
```bash
# No .env.docker needed - tokens sent in HTTP headers
```

### 3. Run Container

**Option A: Using docker-compose (recommended)**

Single-user mode:
```bash
docker-compose --env-file .env.docker up -d
```

Multi-user mode:
```bash
# Edit docker-compose.yml to remove API_TOKEN
docker-compose up -d
```

**Option B: Using docker run**

Single-user mode:
```bash
docker run -d \
  --name mcp-server \
  -p 3003:3003 \
  -v $(pwd)/profiles:/app/profiles:ro \
  -e OPENAPI_SPEC_PATH=/app/profiles/gitlab/openapi.yaml \
  -e MCP_PROFILE_PATH=/app/profiles/gitlab/developer-profile.json \
  -e API_TOKEN=your_token \
  -e API_BASE_URL=https://gitlab.com/api/v4 \
  mcp4openapi:latest
```

Multi-user mode:
```bash
docker run -d \
  --name mcp-server \
  -p 3003:3003 \
  -v $(pwd)/profiles:/app/profiles:ro \
  -e OPENAPI_SPEC_PATH=/app/profiles/gitlab/openapi.yaml \
  -e MCP_PROFILE_PATH=/app/profiles/gitlab/developer-profile.json \
  -e API_BASE_URL=https://gitlab.com/api/v4 \
  -e MCP_TRANSPORT=http \
  -e MCP_HOST=0.0.0.0 \
  mcp4openapi:latest
# Clients send: Authorization: Bearer <user_token>
```

### 4. Connect to the Server

Reuse the IDE configuration examples from the README instead of maintaining duplicates here:

- [Configuration file locations and VS Code prompt setup](../README.md#option-a-npx)
- [Cursor remote connection using `mcp-remote`](../README.md#option-a-npx)
- [Claude Code CLI registration](../README.md#option-a-npx)
- [JetBrains IDE authorization prompt](../README.md#option-a-npx)

Those snippets include token-prompt configuration and certificate guidance that apply to Docker deployments unchanged.

### 5. Verify

```bash
# Check health
curl http://localhost:3003/health

# Check logs
docker-compose logs -f mcp-server
```

## Multi-stage Build

The Dockerfile uses multi-stage build for:
- **Smaller image size**: Only production dependencies in final image
- **Faster builds**: Better layer caching
- **Security**: Non-root user, minimal attack surface

**Image sizes**:
- Builder stage: ~500 MB
- Final image: ~200 MB

## Configuration

### Environment Variables

All standard environment variables are supported.

### Volume Mounts

**Profiles** (required):
```bash
-v path/to/profiles:/app/profiles:ro
```

## Security

### Non-root User

Container runs as user `mcp` (UID 1000, GID 1000):
```dockerfile
USER mcp
```

**Why UID 1000?** Matches default host user (most Linux distros), avoiding permission issues with mounted volumes. No need to `chown` files on host.

### Network Exposure

**Default**: Binds to `0.0.0.0:3003` for container networking
**Production**: Use reverse proxy (nginx, Traefik etc.) for SSL/TLS

### Secrets Management

**Option 1: Docker secrets** (Docker Swarm)
```yaml
secrets:
  - api_token

secrets:
  api_token:
    external: true
```

**Option 2: Environment file**
```bash
docker run --env-file .env.docker ...
```

**Option 3: Kubernetes secrets**
```yaml
env:
  - name: API_TOKEN
    valueFrom:
      secretKeyRef:
        name: mcp-secrets
        key: api-token
```

## Health Check

Built-in health check:
```bash
# Check container health
docker ps

# Manual health check
curl http://localhost:3003/health
```

## Resource Limits

Set in `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '1'
      memory: 512M
    reservations:
      cpus: '0.25'
      memory: 128M
```

## Monitoring

### Logs

**Structured JSON logs** (default):
```bash
docker-compose logs -f mcp-server | jq .
```

**Switching to Console logs**:
```yaml
environment:
  - LOG_FORMAT=console
```

### Metrics

Enable Prometheus metrics:
```yaml
environment:
  - METRICS_ENABLED=true
```

Access metrics:
```bash
curl http://localhost:3003/metrics
```

## Production Deployment Examples

### 1. Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate /etc/ssl/certs/mcp.crt;
    ssl_certificate_key /etc/ssl/private/mcp.key;

    location / {
        proxy_pass http://mcp-server:3003;
        proxy_http_version 1.1;
        
        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        
        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable heartbeat for reverse proxies:
```yaml
environment:
  - HEARTBEAT_ENABLED=true
  - HEARTBEAT_INTERVAL_MS=30000
```

### 2. Docker Swarm

```bash
docker stack deploy -c docker-compose.yml mcp-stack
```

### 3. Kubernetes

Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp4openapi
  namespace: mcp4openapi-group
  labels:
    app: mcp4openapi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp4openapi
  template:
    metadata:
      labels:
        app: mcp4openapi
    spec:
      automountServiceAccountToken: false
      containers:
      - name: mcp4openapi
        image: docker.io/davidruzicka/mcp4openapi:latest
        ports:
        - containerPort: 3003
          protocol: TCP
        env:
        - name: HEARTBEAT_ENABLED
          value: "true"
        - name: API_BASE_URL
          value: https://your-api-instance/api/v4
        - name: OPENAPI_SPEC_PATH
          value: /app/profiles/your-openapi-spec.yaml
        - name: MCP_PROFILE_PATH
          value: /app/profiles/your-mcp-profile.json
        - name: METRICS_ENABLED
          value: "true"
        # uncomment in case of self-signed CAs
        #- name: NODE_EXTRA_CA_CERTS
        #  value: /path/to/ca-bundle.pem
        resources:
          limits:
            cpu: 4000m
            memory: 4Gi
          requests:
            cpu: 250m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 3003
            scheme: HTTP
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 1
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 3003
            scheme: HTTP
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 1
          failureThreshold: 3
```

## Custom CA Certificates

Follow the consolidated guidance in the [README](../README.md#custom-ca-certificates) for Linux, Windows, and macOS trust store configuration. The steps are identical for Docker deployments.

## Troubleshooting

### Container won't start

**Check logs**:
```bash
docker-compose logs mcp4openapi
```

**Common issues**:
- Missing `API_TOKEN` environment variable
- Invalid `OPENAPI_SPEC_PATH` or `MCP_PROFILE_PATH`
- Profiles directory not mounted

### Permission denied

**Ensure volume permissions**:
```bash
chmod -R 755 path/to/profiles/
```

### Health check failing

**Manual test**:
```bash
docker exec mcp4openapi wget -O- http://localhost:3003/health
```

### High memory usage

**Reduce limits in docker-compose.yml**:
```yaml
deploy:
  resources:
    limits:
      memory: 256M
```

### IDE Connection Issues

**Cursor:**
1. Open "Output" panel (Ctrl+Shift+U / Cmd+Shift+U)
2. Select "MCP: ..." from dropdown with your MCP server name
3. Check for connection errors or authentication issues

**VS Code:**
1. Open "Output" from View menu
2. Select problematic MCP server from dropdown
3. Review MCP tool logs for errors

**JetBrains IDEs:**
1. Open "Help" → "Show Log in <your_explorer>" → "mcp" directory to access MCP log files
2. Check `<your_mcp_server>.log` for MCP-related errors

**Common connection issues:**
- **Connection refused:** Check if MCP server is running and accessible
- **Authentication failed:** Verify token is correct and has required permissions
- **Certificate errors:** Configure Node.js to trust custom CA certificates (see [README guidance](../README.md#custom-ca-certificates))

## Development

### Hot reload (not supported)

For development, run locally:
```bash
npm run dev
```

### Build without cache

```bash
docker build --no-cache -t mcp4openapi .
```

### Multi-platform build

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t mcp4openapi \
  .
```

## Examples

### Minimal Example

```bash
docker run -d \
  -p 3003:3003 \
  -v path/to/profiles:/app/profiles:ro \
  -e OPENAPI_SPEC_PATH=/app/profiles/gitlab/openapi.yaml \
  -e MCP_PROFILE_PATH=/app/profiles/gitlab/developer-profile.json \
  -e API_TOKEN=$API_TOKEN \
  -e API_BASE_URL=$API_BASE_URL \
  mcp4openapi
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Build Docker image
  run: docker build -t mcp4openapi:${{ github.sha }} .

- name: Push to registry
  run: |
    docker tag mcp4openapi:${{ github.sha }} registry.example.com/mcp4openapi:latest
    docker push registry.example.com/mcp4openapi:latest
```

### GitLab CI

```yaml
build:
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
```

## Best Practices for Production

1. **Use specific tags**: `mcp4openapi:v1.0.0` not `latest` (controlled upgrades)
2. **Limit resources**: Set CPU/memory limits
3. **Health checks**: Always configure health checks
4. **Structured logs**: Use JSON format for log aggregation
5. **Secrets**: Never commit `.env` files to git (even development ones)
6. **Updates**: Rebuild image regularly for security patches
7. **Monitoring**: Enable metrics collection

## References

- [Dockerfile best practices](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
- [Docker Compose documentation](https://docs.docker.com/compose/)
- [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
