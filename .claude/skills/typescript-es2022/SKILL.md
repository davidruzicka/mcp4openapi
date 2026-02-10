---
name: typescript-es2022
description: Use when implementing or refactoring TypeScript files (`.ts`) in this repository. Applies TypeScript 5.x and ES2022 development rules from former `.github/instructions/typescript-5-es2022.instructions.md`.
---

# TypeScript 5.x ES2022

## Core intent
- Respect existing architecture and coding standards.
- Prefer readable, explicit solutions over clever shortcuts.
- Extend current abstractions before inventing new ones.
- Prioritize maintainability and clarity.

## General guardrails
- Target TypeScript 5.x / ES2022 and prefer native features over polyfills.
- Use pure ES modules; never emit CommonJS patterns.
- Rely on project build, lint, and test scripts unless asked otherwise.
- Note design trade-offs when intent is not obvious.

## Project organization
- Follow repository folder and responsibility layout for new code.
- Use kebab-case filenames unless told otherwise.
- Keep tests, types, and helpers near implementation when it improves discoverability.
- Reuse shared utilities before adding new ones.

## Naming and style
- Use PascalCase for classes, interfaces, enums, and type aliases; camelCase for everything else.
- Exception: snake_case is permitted for DTOs, API contracts, and configuration files where external formats dictate it.
- Skip interface prefixes like `I`.
- Name things for behavior or domain meaning, not implementation details.

## Formatting and style
- Run repository lint/format scripts where defined.
- Match project formatting conventions.
- Keep functions focused; extract helpers when branching grows.
- Favor immutable data and pure functions when practical.

## Type system expectations
- Avoid `any`; prefer `unknown` plus narrowing.
- Use discriminated unions for event/state flows.
- Centralize shared contracts instead of duplicating shapes.
- Use utility types (`Readonly`, `Partial`, `Record`) to express intent.

## Async, events, and error handling
- Use async/await.
- Guard edge cases early to avoid deep nesting.
- Send errors through project logging/telemetry utilities.
- Surface user-facing errors via repository patterns.
- Debounce config-driven updates and dispose resources deterministically.

## Architecture and patterns
- Follow repository dependency injection/composition patterns.
- Observe existing initialization/disposal sequences in lifecycles.
- Keep transport, domain, and presentation layers decoupled with clear interfaces.
- Add lifecycle hooks and targeted tests when adding services.

## External integrations
- Instantiate clients outside hot paths and inject for testability.
- Never hardcode secrets.
- Apply retries/backoff/cancellation for network and IO calls.
- Normalize external responses and map errors to domain shapes.

## Security practices
- Validate and sanitize external input with schema validators or type guards.
- Avoid dynamic code execution and untrusted template rendering.
- Encode untrusted content before rendering HTML.
- Use parameterized queries or prepared statements.
- Keep secrets in secure storage with least-privilege scopes.
- Favor immutable flows and defensive copies for sensitive data.
- Use vetted crypto libraries only.
- Patch dependencies promptly and monitor advisories.

## Configuration and secrets
- Access config via shared helpers and validate with schemas/validators.
- Handle secrets via secure storage; guard undefined/error states.
- Document new config keys and update related tests.

## UI and UX components
- Sanitize user/external content before rendering.
- Keep UI layers thin; move heavy logic to services/state managers.
- Use events/messages to decouple UI from business logic.

## Testing expectations
- Add or update unit tests with project framework and naming style.
- Expand integration/E2E tests when behavior crosses module boundaries.
- Run targeted test scripts for quick feedback.
- Avoid brittle timing assertions; use fake timers or injected clocks.

## Performance and reliability
- Lazy-load heavy dependencies and dispose when done.
- Defer expensive work until needed.
- Batch or debounce high-frequency events.
- Track resource lifetimes to prevent leaks.

## Documentation and comments
- Add JSDoc to public APIs; include `@remarks` or `@example` when helpful.
- Write comments that capture intent and remove stale notes.
- Update architecture/design docs when introducing significant patterns.
