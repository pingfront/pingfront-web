// The service worker's entry (vite build --mode sw writes it as dist/pingfront-sw.js). It runs only in a
// ServiceWorkerGlobalScope, so it compiles with the WebWorker library (tsconfig.sw.json), not the DOM one.
import { install } from "./sw.js";

declare const self: ServiceWorkerGlobalScope;

install(self);
