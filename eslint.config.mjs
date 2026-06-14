// ESLint 9 flat config. Next 16 dropped `next lint`; eslint-config-next ships a
// flat config directly, so we consume it and run ESLint via the CLI.
import next from "eslint-config-next/core-web-vitals";

export default [
  ...next,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "src/generated/**",
      "spikes/**",
      "generated-tests/**",
    ],
  },
];
