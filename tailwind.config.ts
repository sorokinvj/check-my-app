import type { Config } from "tailwindcss";

// Status palette is product-canonical — see Mockups "Visual / brand notes".
// green ✅ ok · yellow 🟡 confusing · orange ⚠ risky · red 🔴 broken · purple ⚠ exposed
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        status: {
          ok: "#16a34a",
          confusing: "#eab308",
          risky: "#f97316",
          broken: "#dc2626",
          exposed: "#9333ea",
        },
      },
    },
  },
  plugins: [],
};

export default config;
