---
name: javascript-es2022
description: Use when implementing or refactoring JavaScript files (`.js`, `.mjs`, `.cjs`) in this repository. Applies Node.js 20+ ES2022 style, testing, and interaction rules from former `.github/instructions/javascript-es2022.instructions.md`.
---

# JavaScript ES2022

## Coding standards
- Use JavaScript with ES2022 features and Node.js (20+) ESM modules.
- Use Node.js built-in modules and avoid external dependencies where possible.
- Ask the user if additional dependencies are required before adding them.
- Always use async/await for asynchronous code, and use `node:util` `promisify` to avoid callbacks.
- Keep the code simple and maintainable.
- Use descriptive variable and function names.
- Do not add comments unless absolutely necessary; code should be self-explanatory.
- Never use `null`; always use `undefined` for optional values.
- Prefer functions over classes.

## Naming and style
- Use PascalCase for classes, interfaces, enums, and type aliases; use camelCase for everything else.
- Exception: snake_case is permitted for DTOs, API contracts, and configuration files where external formats dictate it.
- Skip interface prefixes like `I`; rely on descriptive names.
- Name things for behavior or domain meaning, not implementation details.

## Testing
- Use Vitest for testing.
- Write tests for all new features and bug fixes.
- Ensure tests cover edge cases and error handling.
- Never change production code to make it easier to test; test the real behavior.

## Documentation
- When adding new features or making significant changes, update `README.md` where necessary.

## User interactions
- Ask questions if implementation details or design choices are unclear.
- Always answer in the same language as the question, but keep generated code, comments, and docs in English.
