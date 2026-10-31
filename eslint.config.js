import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // .claude/worktrees holds other sessions' checkouts; each one lints itself.
  { ignores: ["**/node_modules/**", "**/out/**", "**/dist/**", ".claude/**", "design/prototype.html", "catalog/providers.json", "apps/web/.next/**", "apps/web/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}", "apps/web/{app,components,lib}/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    rules: { "@typescript-eslint/consistent-type-imports": "off" },
  },
  // electron-builder loads its config and signing hook as CommonJS (apps/desktop/scripts/*.cjs).
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/consistent-type-imports": "off", "@typescript-eslint/no-require-imports": "off" },
  },
);
