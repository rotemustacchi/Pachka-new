import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noPhysicalDirection from "./eslint-rules/no-physical-direction.mjs";

// A small local plugin, not published anywhere: PACHKA is RTL by default
// (ARCHITECTURE.md, task 1.2), so a physical-direction Tailwind utility
// (ml-, pr-, text-left, border-r, ...) is treated as a lint error rather
// than a style preference.
const localPlugin = {
  rules: {
    "no-physical-direction": noPhysicalDirection,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { local: localPlugin },
    rules: {
      "local/no-physical-direction": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
