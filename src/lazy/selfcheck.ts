// The self-check (selfCheck()): sends "Setup check from <app>" and turns the outcome into one code and what to do.
// Developers run it while setting up, people never do, so this is a lazy module (core/modules.ts): it works through
// the engine it is given.
import type { Engine, SelfCheckResult } from "../core/engine.js";

export type Outcome = Omit<SelfCheckResult, "line">;

const no = (code: string, advice: string): Outcome => ({ passed: false, code, advice });

export async function run(e: Engine, timeoutMs: number): Promise<Outcome> {
  const appName = e.options.appName ?? (typeof document !== "undefined" ? document.title : "") ?? "";
  const ctrl = new AbortController();
  const send = (async () => {
    await e.session.token("prepare");
    await e.api.send({ method: "POST", path: "/thread/messages", auth: "bearer", scope: "messages", body: { clientId: e.rt.uuid(), text: `Setup check from ${appName || "the web"}` }, signal: ctrl.signal });
    return null;
  })().catch((x: unknown) => x);
  let timer: unknown;
  const timeout = new Promise<"timeout">((resolve) => (timer = e.rt.setTimeout(() => resolve("timeout"), timeoutMs)));
  const outcome = await Promise.race([send, timeout]);
  e.rt.clearTimeout(timer);
  ctrl.abort();
  if (outcome === null) {
    const p = e.state.problem;
    if (p && p.code.startsWith("identity_")) return no(p.code, p.message);
    return { passed: true };
  }
  if (outcome === "timeout") return no("timeout", `No answer in ${Math.round(timeoutMs / 1000)} s: check baseUrl.`);
  return describe(e, outcome);
}

function describe(engine: Engine, x: unknown): Outcome {
  const e = engine.apiError(x);
  if (!e) return no("unexpected", "Unexpected failure: run with logLevel \"debug\".");
  if (e.kind === "network" || e.kind === "timeout") return no("network", "API unreachable: check the network and baseUrl.");
  if (e.kind === "cooling_down" || e.status === 429) return no("rate_limited", "Rate limited: wait a minute.");
  const advice: Record<string, [string, string]> = {
    invalid_app_key: ["key_unknown", engine.advice.keyUnknown],
    origin_not_allowed: ["origin_not_allowed", engine.advice.origin()],
    app_paused: ["app_paused", "The app is paused. Resume it in Dashboard > App > Settings."],
    blocked: ["blocked", "This person is blocked: unblock them in the dashboard."],
    identity_user_mismatch: ["identity_user_mismatch", engine.advice.identity("user_mismatch")],
  };
  return no(...(advice[e.code] ?? [e.code, e.message]));
}
