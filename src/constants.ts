// The product's names, in one place. The product is about to be renamed: change these, not the code.
// Nothing else in the SDK spells the product, its global, its element or its storage names.

/** The JavaScript global of the script build and the self-check prefix. */
export const GLOBAL_NAME = "PingFront";
/** `PF-SDK` name (`<name>/<version>`) and `Device.sdk.name`. */
export const SDK_NAME = "pingfront-web";
export const SDK_VERSION = "1.0.0";
/** Where the script build is published; its language packs load from `locales/` next to it (RELEASING.md). */
export const DEFAULT_CDN_BASE = `https://cdn.pingfront.sh/web/${SDK_VERSION}/`;
/** The custom element the chat renders into (shadow DOM). */
export const ELEMENT_TAG = "pingfront-chat";
/** The message the service worker posts to an open page when a notification is clicked. */
export const OPEN_MESSAGE = "pingfront-open";
/** The fragment a newly opened page carries after a notification click. */
export const OPEN_FRAGMENT = "#pingfront-open";
/** The event a lazy module's script (locales/<name>.js) dispatches on its own element with its exports. */
export const MODULE_EVENT = "pingfront-module";
/** IndexedDB database, and the BroadcastChannel prefix tabs coordinate on. */
export const STORAGE_NAME = "pingfront";
/** Production API. Point `baseUrl` elsewhere only for a local server. */
export const DEFAULT_BASE_URL = "https://api.pingfront.sh/v1";
/** Where the dashboard lists the app's allowed web origins (named in errors). */
export const DASHBOARD_ORIGINS_PATH = "Dashboard > App > Settings > Web origins";
