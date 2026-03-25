# Tech Stack

## Language & Runtime

- **Language:** TypeScript 5.9.3 (strict mode, ES2022 target, `verbatimModuleSyntax`)
- **Runtime:** Node.js 18+ (engines field; implementor workflow requires Node.js 22)
- **Module system:** ESM (`"type": "module"` in package.json)
- **Build:** `tsc` to `dist/`, source maps enabled

## Core Frameworks

| Framework | Version | Purpose |
|-----------|---------|---------|
| `@modelcontextprotocol/sdk` | 1.26.0 | MCP server/transport primitives |
| `express` | 5.2.1 | HTTP transport layer |
| `zod` | 3.x | Runtime schema validation (auto-generated schemas) |
| `jose` | 6.2.1 | JWT signing/verification, JWK handling (OAuth) |
| `yaml` | 2.x | OpenAPI spec parsing (YAML + JSON) |
| `swagger-parser` | 10.x | OpenAPI spec validation and $ref resolution |

## Testing

| Tool | Version | Purpose |
|------|---------|---------|
| `vitest` | latest | Test runner (unit, integration, e2e) |
| `@vitest/coverage-v8` | latest | V8-based code coverage |
| `msw` (Mock Service Worker) | 2.x | HTTP mocking for integration tests |

## Security & Observability

| Package | Purpose |
|---------|---------|
| `prom-client` | Prometheus metrics emission |
| `express-rate-limit` | Rate limiting middleware |
| `ipaddr.js` | SSRF validation (IP range / CIDR checks) |
| `dotenv` | Environment variable loading |

## Build & Tooling

- **TypeScript compiler:** `tsc` (strict, no implicit any, `isolatedModules`)
- **Schema generation:** `ts-json-schema-generator` 2.5.0 (requires Node 22; TypeScript -> JSON Schema -> Zod)
- **Linting:** ESLint with TypeScript rules
- **Docker:** Multi-stage build (`node:22-alpine` base)
- **CI:** GitHub Actions (Node.js 22 for implementor pipeline, Node.js 20 for main CI - see issue #224)
- **Package manager:** npm with lockfile (`package-lock.json`)

## Configuration

- Environment variables via `process.env` (documented in `README.md`)
- Profile-driven configuration via JSON profile files (`profiles/`)
- Runtime validation via auto-generated Zod schemas (`src/generated-schemas.ts`)
- Three schema systems in sync: TypeScript types -> JSON Schema (`profile-schema.json`) -> Zod (see `AGENTS.md`)
- `npm run generate-schemas` regenerates Zod + JSON Schema from TypeScript types
