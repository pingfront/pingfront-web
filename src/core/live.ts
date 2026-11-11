// The chat's live socket, as the engine sees it. The socket itself (src/lazy/live.ts) is a lazy module, loaded the first
// time the chat opens (core/modules.ts): the thread loads over HTTP meanwhile, and the socket starts once it is there.
// If it can't load, the chat works as it does where WebSockets are unavailable: replies arrive on reload.
import type { LiveHooks, Socket } from "../lazy/live.js";
import type { Logger } from "./log.js";
import { loadModule } from "./modules.js";
import type { Runtime } from "./runtime.js";

export type { LiveHooks } from "../lazy/live.js";

export class Live {
  #socket: Socket | undefined;
  #wanted = false;
  readonly #rt: Runtime;
  readonly #hooks: LiveHooks;
  readonly #log: Logger;

  constructor(rt: Runtime, hooks: LiveHooks, log: Logger) {
    this.#rt = rt;
    this.#hooks = hooks;
    this.#log = log;
  }

  get running(): boolean {
    return this.#wanted;
  }

  start(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    if (this.#socket) return this.#socket.start();
    this.#hooks.state("connecting");
    void loadModule("live").then((m) => {
      if (!m) return this.#log.error("No live updates: live.js did not load.");
      this.#socket ??= new m.Socket(this.#rt, this.#hooks, this.#log);
      if (this.#wanted) this.#socket.start();
    });
  }

  stop(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    if (this.#socket) this.#socket.stop();
    else this.#hooks.state("closed");
  }

  /** Typing on and off, when the socket is there (src/lazy/live.ts). */
  typing(on: boolean): void {
    this.#socket?.typing(on);
  }
}
