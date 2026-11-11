import "fake-indexeddb/auto";
import { loadModule } from "../src/core/modules";

// The live socket is a lazy module (src/lazy/live.ts): the engine loads it with a dynamic import the first time the
// chat opens. In a test file that first import takes real time (Vite transforms the module), while the tests drive the
// engine on fake timers and expect the socket after advancing them a few milliseconds. On a busy machine the import
// lost that race and `api.sockets[0]` was undefined (the "team-action-pending" scenario, core.test.ts "live",
// held.test.ts). Loading it here, before any test runs, makes the engine's own load a cache hit, as it is on a page
// that has opened the chat once.
await loadModule("live");
