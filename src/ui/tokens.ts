// pingfront's own values come from the design tokens the widget uses (tokens.json), injected at build time by
// vite.config.ts. rem sizes arrive in px: host pages own their root size.
declare const __PF_TOKENS__: Record<string, string | { light: string; dark: string }>;

export const TOKENS = __PF_TOKENS__;

/** The tokens as custom properties for one scheme. */
export const tokenVars = (mode: "light" | "dark") =>
  Object.entries(TOKENS)
    .map(([k, v]) => `--${k}:${typeof v === "string" ? v : v[mode]}`)
    .join(";");
