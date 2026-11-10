/**
 * ESLint 9 "flat config".
 *
 * Deliberately dependency-free: no @eslint/js, no globals package, because
 * CLAUDE.md keeps the dependency list short. Node globals are listed by hand
 * and rules are opted into explicitly, so nothing here is magic.
 */

/** Node.js globals this project actually uses. */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  performance: "readonly",
  structuredClone: "readonly",
  queueMicrotask: "readonly",
  globalThis: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
};

export default [
  {
    // legacy/ is the tutorial code kept as a reference. It is never linted or
    // changed; GossipMesh grows next to it in src/.
    ignores: ["node_modules/**", "legacy/**", "coverage/**", "dist/**", "results/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // Correctness: these catch real bugs, not style opinions.
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-constant-condition": "error",
      "no-unreachable": "error",
      "require-atomic-updates": "error",

      // Habits that matter in a distributed-systems codebase.
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-else-return": "error",
    },
  },
];
