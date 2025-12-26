# Contributing to mcp4openapi

Thank you for considering contributing! This document provides guidelines for developers working on the codebase.

## Development Setup

1. **Clone and install**:
   ```bash
   git clone https://github.com/davidruzicka/mcp4openapi.git
   cd mcp4openapi
   npm install
   ```

2. **Build**:
   ```bash
   npm run build
   ```

3. **Run tests**:
   ```bash
   npm test
   ```

4. **Run with example**:
   ```bash
   export MCP4_OPENAPI_SPEC_PATH=./profiles/gitlab/openapi.yaml
   export MCP4_PROFILE_PATH=./profiles/gitlab/developer-profile-oauth.json
   export MCP4_API_BASE_URL=https://your-gitlab-instance/api/v4
   export MCP4_API_TOKEN=your-token
   npm start
   ```

## Code Style

- Follow existing TypeScript conventions
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Include "Why" comments for non-obvious decisions

## Testing

- Write tests for new important features
- Maintain test coverage above 80%
- Run `npm test` before submitting PR
- Integration tests in `src/testing/`
- Unit tests alongside source files (`*.test.ts`)

## ⚠️ CRITICAL: Profile Schema Synchronization

**When modifying profile schema structure** (adding fields to `ToolDefinition` or `Profile`):

### Two schemas MUST stay in sync:

1. **TypeScript Types** (`src/types/profile.ts`) - **Source of Truth**
   ```typescript
   export interface ToolDefinition {
     // ... existing fields ...
     new_field?: SomeType;
   }
   ```

2. **JSON Schema** (`profile-schema.json`) - **Manual Update Required**
   ```json
   {
     "properties": {
       "new_field": {
         "type": "...",
         "description": "..."
       }
     }
   }
   ```

3. **Zod Schema** (`src/generated-schemas.ts`) - **Auto-generated**
   - Automatically generated from TypeScript types
   - Run `npm run generate-schemas` or `npm run build`
   - No manual updates needed!

### Workflow

1. **Edit** `src/types/profile.ts` (add/modify interface)
2. **Run** `npm run generate-schemas` (auto-generates Zod schemas)
3. **Update** `profile-schema.json` manually (for IDE autocomplete)
4. **Test** with `npm test`

### Why This Approach?

- **TypeScript Types**: Single source of truth, compile-time checking
- **JSON Schema**: Enhanced IDE autocomplete for `.json` files (better than generated)
- **Zod Schema**: Runtime validation, auto-generated = always in sync!

### Auto-Generation Details

The `npm run generate-schemas` script:
- Uses `ts-to-zod` to convert TypeScript → Zod
- Writes to `src/generated-schemas.ts`
- Runs automatically during `npm run build`
- Skips JSON Schema (maintained manually for better IDE experience)

### Debugging Checklist

If a profile field is ignored at runtime:

1. Check TypeScript interface in `src/types/profile.ts`
2. Run `npm run generate-schemas` to regenerate Zod schemas
3. ⚠️ **Check JSON Schema in `profile-schema.json`** ← Manual updates may lag
4. ⚠️ Check for custom Zod refinements in `src/profile-loader.ts` (edge cases)

## Architecture Overview

See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for detailed architecture and design decisions.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Build (`npm run build`)
6. Commit with clear message
7. Push to your fork
8. Open a Pull Request

## Release Process

For maintainers releasing new versions, see [`docs/RELEASING.md`](./docs/RELEASING.md).

## Documentation

When adding features:

- Update `IMPLEMENTATION.md` for architectural changes
- Keep `docs/PROFILE-GUIDE.md` in sync with profile schema
- Add or update examples in `profiles/` if applicable
- Update relevant docs in `README.md` and other `docs/` files
- Remove implemented feature from `TODO.md`

## Questions?

- Check [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for architecture details
- Check [`docs/PROFILE-GUIDE.md`](./docs/PROFILE-GUIDE.md) for profile creation
- Open an issue for discussion

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

