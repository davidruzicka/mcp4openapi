# Multi-stage build for MCP from OpenAPI server
# Why: Smaller final image, faster builds with layer caching

# Stage 1: Build
FROM node:alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript (only src/, not scripts/)
# Why: scripts/ imports from dist/ which doesn't exist yet - scripts are CLI tools, not needed in container
RUN npx tsc --outDir dist --rootDir src

# Stage 2: Production
FROM node:alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Copy profile schema for validation
COPY profile-schema.json ./

# Copy bundled profiles and static HTML
COPY profiles/ /app/profiles/
COPY html/ /app/html/

# Non-root user for security
# Why: UID/GID 1000:1000 matches default host user, avoids permission issues with mounted volumes
RUN if ! getent group 1000 >/dev/null; then \
      addgroup -g 1000 mcp; \
    fi && \
    if ! getent passwd 1000 >/dev/null; then \
      adduser -u 1000 -D -G $(getent group 1000 | cut -d: -f1) mcp; \
    fi && \
    chown -R 1000:1000 /app

USER 1000:1000

# Default environment variables
ENV NODE_ENV=production \
    MCP4_LOG_LEVEL=info \
    MCP4_LOG_FORMAT=json \
    MCP4_TRANSPORT=http \
    MCP4_HOST=0.0.0.0 \
    MCP4_PORT=3003

# Expose HTTP port
EXPOSE 3003

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3003/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start server
CMD ["node", "dist/index.js"]
