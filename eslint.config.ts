import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/", "public/*.js", "coverage/", "test-results/", "playwright-report/", ".wrangler/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // `x!` is how this code says "the page guarantees this element exists".
      "@typescript-eslint/no-non-null-assertion": "off",
      // Empty catch blocks are deliberate: the fallback is the next line.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
