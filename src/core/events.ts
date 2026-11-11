// A small typed emitter. Event names are open: `on("live", …)` also receives frames this version does
// not know (as `{ type: "unknown", name, raw }`), so apps can react to future server events.
export type Handler<T = unknown> = (event: T) => void;

export class Emitter {
  #map = new Map<string, Set<Handler<never>>>();

  on<T = unknown>(type: string, fn: Handler<T>): () => void {
    let set = this.#map.get(type);
    if (!set) this.#map.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  emit(type: string, event: unknown): void {
    for (const key of [type, "*"]) {
      for (const fn of this.#map.get(key) ?? []) {
        try {
          (fn as Handler<unknown>)(key === "*" ? { type, event } : event);
        } catch (e) {
          // A host handler's failure never breaks the chat.
          setTimeout(() => {
            throw e;
          });
        }
      }
    }
  }

  /** True when something listens to `type` (or to every event). */
  has(type: string): boolean {
    return Boolean(this.#map.get(type)?.size || this.#map.get("*")?.size);
  }

  clear(): void {
    this.#map.clear();
  }
}
