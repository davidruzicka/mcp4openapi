import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const testGlobals = {
  afterAll: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  vi: "readonly",
};

export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/__tests__/**/*.ts", "src/testing/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: testGlobals,
    },
  },
];
