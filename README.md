# pingfront for the web

The in-app chat for web apps: the same threads, pings, cards and dashboard as the iOS and Android SDKs,
over the same `/v1` contract ([OpenAPI](https://pingfront.sh/openapi.yaml), [API reference](https://pingfront.sh/docs/reference)).
An npm package (`@pingfront/web-widget`) and a single script, with no runtime dependencies. MIT licensed.

The developer guide is [pingfront.sh/docs/web](https://pingfront.sh/docs/web).

## Quickstart

1. In **Dashboard › App › Settings › Web origins**, add the origin your app runs on (`https://app.example.com`).
   The server refuses browser requests from any other origin (`origin_not_allowed`, 403).
2. Add the script, from the CDN (pinned, with its SRI hash from the release manifest) or your own server:

   ```html
   <script src="https://cdn.pingfront.sh/web/1.0.0/pingfront.js" integrity="sha384-grtXghv6Hp5kDj7wvSNw7RKBKtTJLFk81ReL5ES9mP+W0Mk2apILUVm9+OnTisK2" crossorigin="anonymous"
           data-app-key="pk_live_…" defer></script>
   <script src="/pingfront.js" data-app-key="pk_live_…" defer></script>
   ```

   `https://cdn.pingfront.sh/web/v1/pingfront.js` always serves the latest 1.x (no SRI, cached 5 minutes).
   Every upload, with its hash, is recorded in [`releases.json`](releases.json).
   Serving it yourself, serve the build's `locales/` folder next to `pingfront.js`: the language packs and the
   [lazy modules](#lazy-modules) (the live socket, web push) load from there.

   or the package (`npm install @pingfront/web-widget`):

   ```ts
   import { PingFront } from "@pingfront/web-widget";
   PingFront.configure("pk_live_…");
   ```

3. Check it: `(await PingFront.selfCheck()).line` is `PingFront self-check: PASS`.

## API

| Call | What it does |
| --- | --- |
| `configure(appKey, options)` | Checks the key offline (CRC check characters) and adds the launcher. Sends nothing. Options: `baseUrl`, `launcher`, `locale`, `topics`, `appearance`, `appName`, `app`, `logLevel`, `logHandler`, `presentsChatForMoments`, `unreadOnLoad`, `debug`, `container`, `launcherOffset`, `push`. |
| `identify(token)` / `identify({ userId, name, email, token })` | Stages the identity (sent with the session, or coalesced into one `PATCH /me` after 250 ms). A verified token gives one thread across devices. |
| `setTraits(traits)` | Same coalescing. |
| `logout()` | Queues `POST /me/logout` (persisted, retried) and wipes this browser. The next session is a new guest. |
| `eraseMyData()` | `DELETE /me`, then the same wipe. An install the server already forgot counts as erased. |
| `exportMyData()` | `GET /me/export`: everything the server stores about the person, as parsed JSON. |
| `setEntitlement(plan)` | The person's plan from your web billing (`source: "stripe"`); any `environment` other than `production` is a test plan. Sent with the next `PATCH /me` once a session exists. |
| `setOffers(slots)` | The paywalls the team can send as offer cards (source `app` by default). Same `PATCH /me`. |
| `reportBug(text, { screenshots, logTail, state })` | `POST /reports`: up to three screenshots (uploaded like photos), the last 64 KB of your log, short key/value state. The report shows in the thread with a receipt; emits `reportSent`. |
| `enablePush({ serviceWorker })` | Shows the browser's notification prompt, subscribes, and registers the subscription (`PATCH /me` push `webpush`). Call it from a person's action. Resolves `"enabled"`, `"denied"`, `"unsupported"`, `"unavailable"` (the server has no push key), `"rejected"` (the server refused it; the browser subscription is removed) or `"failed"`. |
| `disablePush()` | `push: null`, and the browser subscription is removed. Logout and erase remove it too. |
| `open({ topic })`, `close()` | The chat. A topic prefills the composer. `close()` is synchronous: there is nothing to wait for. |
| `setLocale(tag)`, `locale` | The chat's language at runtime, for apps with their own language picker (`"de"`, `"pt-BR"`; `undefined` follows the browser). The chat re-renders in it at once, without configuring again; nothing goes to the API (a language pack may load from where the script was served). An invalid tag is ignored and logged. |
| `handleUrl(url = location.href)` | Opens the chat for a chat link (`?pingfront=chat` or `?pingfront=report`, optional `topic`) and returns `true`; `false` for any other URL. `configure` already runs it for the page. Sends nothing itself. See [Links into the chat](#links-into-the-chat). |
| `moment(name, props)` | Sent only when a play listens to it (`GET /moments/listened`, cached 5 minutes). An `open` answer opens the chat. |
| `onUnreadCount(fn)` | Called now and on every change; returns an unsubscribe. |
| `on(event, fn)` | `message`, `unread`, `open`, `close`, `offer`, `link`, `problem`, `sent`, `reportSent`, `cardOpened`, `teamAction`, `sessionRevoked`, `live`, or `*`. `chatOpened` and `messageSent` (the native names) subscribe to `open` and `sent`; `*` reports them by the web names. `sessionRevoked` fires after the server revoked the install (a refused refresh, `session_revoked` on any route, or live close 4004) and the widget wiped its local state, unsent messages included; never for `logout()` or `eraseMyData()`. `cardOpened` gets `{ kind, cardId, messageId }` when the person taps a card or answers one, as on iOS and Android (never the card's text). `teamAction` delivers a "Fix it for them" action once; do the work, then call its `complete()` or `fail(message)`. `live` gets every server frame; frames this version doesn't know arrive as `{ type: "unknown", name, raw }`. |
| `onOffer(fn)` | Offer cards call it with `{ offerId, cardId, messageId, storeOffer, title }`: open your paywall. Until a handler (or an `offer` listener) is set, offer cards say "Not available in this app" in place of a button that would do nothing. |
| `onLink(fn)` | Return `true` to handle a link (deep links, your app's own scheme); otherwise an `http` or `https` link opens in a new tab and any other scheme opens nothing. A `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, `content:` or `intent:` link never reaches it: the widget refuses it first, and a link card reports `cannot_open` ([link card URLs](https://pingfront.sh/docs/chat-links)). It is synchronous, unlike iOS and Android's async `onLink`: the widget's `window.open` must run inside the person's click, or popup blockers stop it. |
| `registerScreens([{ id, title? }])` | Your app's screens for saved links: ids match `^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$`, each once, at most 200 (a bad entry throws in debug and is dropped otherwise). Sent in `device.app.screens` on the session create, and on a refresh or `PATCH /me` only when the list or the app version changed (a hash is kept); never a request of its own. |
| `onScreen(fn)` | Opens a registered screen for a link card's `screen` (`{ id, params }`); return `true` or a Promise of `true`. No answer within 10 s counts as `not_handled` (as on iOS and Android) and a later answer is ignored. A screen the page didn't register falls back to the card's `url`. Each tap sends one `POST /thread/cards/{id}/act`: `opened`, or `failed` with `not_handled`, `unknown_screen` or `cannot_open`. |
| `selfCheck()` | Sends "Setup check from <app>" and resolves `{ passed, code, advice, line }`; also prints the line. |
| `prepare()` | Creates the session now. |
| `create(appKey, options)` | A separate instance (the `PingFront` singleton wraps one). Instances also have `destroy()`, which removes the chat and stops everything. |
| `unreadCount`, `isOpen`, `problem`, `person`, `isTestDevice`, `storeAccountToken` | Read-only state (the last three once a session exists). |

`logHandler: ({ level, message }) => …` receives the same redacted lines as the console (constants, route
names, statuses and codes; never text, names, tokens or ids). A handler that throws is ignored.

## Web push

Team replies and pings reach the person's browser like APNs and FCM reach the apps, when the chat isn't
open. The widget never asks for permission on its own: only from a person's tap.

1. Serve `pingfront-sw.js` from your own origin (a service worker can't come from a CDN): copy
   `dist/pingfront-sw.js` from the package (`@pingfront/web-widget/sw`) or a build of this repository, for example to
   `/pingfront-sw.js`. Its folder is its scope, so the root covers every page. It is under 2 KB, keeps no
   state and makes no requests.
2. Pass `push: { serviceWorker: "/pingfront-sw.js" }` to `configure()`. The chat then offers "Turn on
   notifications" under the person's first message, as the iOS and Android chats do, while this browser hasn't
   decided and the server has a web push key; the person's tap shows the browser's prompt, and the offer goes
   whatever they choose. From your own button or setting, call `await PingFront.enablePush()` (it uses the same
   worker; `enablePush({ serviceWorker })` names another).
3. A notification shows the app's push title and body. Clicking it focuses an open page of your site and
   opens the chat there, or opens the page where `enablePush()` ran with the chat open (`#pingfront-open`).

A new session re-sends a subscription the browser rotated. Pages need a secure context (https, or
localhost). Safari needs the site added to the Home Screen on iOS.

## Links into the chat

A link to any page of your app with `?pingfront=chat` opens the chat when the page loads: from an email, a QR
code saying "Message us", or a "Chat with us" button elsewhere. The format and its rules are in
[the chat links guide](https://pingfront.sh/docs/chat-links), the same on every SDK.

```text
https://app.example.com/settings?pingfront=chat
https://app.example.com/?pingfront=chat&topic=billing
```

- `configure` (and the script tag) handles the page's own URL, then removes `pingfront` and `topic` from the
  address bar with `history.replaceState`; other parameters, the fragment and `history.state` stay, and a
  reload doesn't open the chat again.
- `topic` applies only when it is one of the chat's topics (the dashboard's, else the `topics` option). A
  dashboard topic is matched once the app's config has loaded as the chat opens. It does what
  `open({ topic })` does; a link never carries text for the composer.
- `pingfront=report` opens the chat: on the web the bug report is the composer, where people paste a screenshot.
- A single-page app that changes the URL itself calls `PingFront.handleUrl()` after navigating (it returns
  `false` for anything else). Called before `configure`, a chat link is kept in memory and applied once by
  `configure`, instead of the page's own URL.
- Handling a link sends nothing; the chat opening starts the session, as `open()` does. Notification clicks
  keep using `#pingfront-open`.

## Appearance

The look a team publishes in **Dashboard › App › Look** wins, field by field. `appearance` fills only the
fields the dashboard left unset, the same fields as the iOS `ChatAppearance` and the Android equivalent:

```ts
PingFront.configure("pk_live_…", {
  appearance: { accent: { light: "#5856D6", dark: "#5E5CE6" }, corners: "soft", headerStyle: "team" },
});
```

| Field | Values (default first) |
| --- | --- |
| `accent`, `background`, `teamBubble` | `"#RRGGBB"` or `{ light, dark }`. Text is kept at 4.5:1, as on iOS: the accent deepens, surfaces move. |
| `scheme` | `"auto"` (follows the system), `"light"`, `"dark"` |
| `font` | `"system"`, `"rounded"`, `"serif"` (system stacks; host page fonts never apply) |
| `corners` | `"round"` (18 px with tails), `"soft"` (12 px), `"square"` (6 px) |
| `density` | `"comfortable"`, `"compact"` |
| `headerStyle`, `headerMemberId`, `headerTitle` | `"person"` (one face), `"team"` (up to three faces), `"app"` (the app icon: the store icon from the dashboard, else the site's own `apple-touch-icon`, largest PNG or SVG icon, or `/favicon.ico`, else the app's first letter); which teammate; a title instead of the name |
| `showLocalTime`, `showReplyExpectation`, `replyExpectation` | `true`, `true`; the reply line's text |
| `welcomeTitle`, `welcomeBody`, `showFaces` | the empty state's text; faces on it (`true`) |
| `placeholder`, `photos` | the composer's placeholder; the photo button (`true`) |
| `showNames`, `showAvatars`, `timestamps` | `true`, `true`, `"grouped"` or `"always"` |
| `aiName` | `"Assistant"` |

A value outside these (a typo, `"#fff"`, a value from a newer SDK) is ignored and the default applies.
`launcher: false` hides the floating button so your own button calls `PingFront.open()`. The launcher sits
20 px from the bottom right corner (the end corner in right-to-left pages, above the home indicator's safe area)
above page content. A page with its own bottom bar moves it, and the panel above it, with
`launcherOffset: { bottom: 88, end: 20 }` (px).

### Embedded

`container: element` puts the chat inside that element instead of floating it: it fills the element (give the
element a height), with no launcher, scrim or close button, and it is a region of the page rather than a modal
dialog, like the iOS SDK's embeddable view. `open()` shows it and starts the session (nothing is sent before).
An embedded chat is part of the page's flow, so the browser scrolls its focused composer into view above an on-screen
keyboard, as it does for the page's own fields. Opening it never moves focus. A page that loads a second copy of the
widget (the script and the npm package, or two versions) gets the second chat as `pingfront-chat-2`, since the
first copy's class already owns `pingfront-chat`.

## Parity with the native SDKs

| Behaviour | Web |
| --- | --- |
| Lazy sessions | Same: nothing on page load (checked end to end in Chrome). Unread polling starts only after a session exists in this page, unless `unreadOnLoad: true`. |
| Identity storage | The install secret in IndexedDB, namespaced per app key. Where IndexedDB is unavailable (some locked-down browsers), memory: the install lasts as long as the page, and a reload starts a new guest when the chat next opens. Never a cookie, which would send the install secret to your own server with every request. The access token is memory only. |
| Refresh | From `accessExpiresIn` on the monotonic clock; one refresh and one retry after a 401 `unauthorized`, never for another person (a logout during the refresh cancels it); a refused install starts a new guest on the person's next action. Only a person's action creates a session: background work (read receipts, card reports, profile changes, the socket) only refreshes one. |
| Tabs | Tabs of one origin share the install, outbox and card reports in IndexedDB. A `BroadcastChannel` tells the other tabs about a logout, an erase or a new install: they forget the person from memory (no `sessionRevoked`) and read the stored install again. Queues are merged item by item, never overwritten, and a refused install is deleted only while it is still the stored one. |
| Outbox | Idempotent `clientId` per message, delivered in tap order, retried after `min(1 s·2ⁿ, 5 min)` ±20 %, persisted with its photos in IndexedDB. A 409 `thread_reset` reloads the thread and sends again once; a second one fails the message. |
| Card actions | Each report (a tap's outcome, a pick, a rating) has its own `clientId`, kept with it in IndexedDB (else memory) and resent unchanged: no answer, 408, 429 and 500/502/503/504 retry after `min(1 s·2ⁿ, 5 min)` ±20 % (or a longer `retryAfter`), at once when the browser is back online or the page in view; 401 refreshes once; 409 `thread_reset` retries once while the message is still there; other 4xx drop. Dropped after 24 h or 10 attempts, cleared on logout. |
| Live | `pingfront.v1, bearer.<token>`, ping every 30 s, a silence deadline, reconnect `min(1 s·2ⁿ, 30 s)` ±20 %, seq gap repair, `reauth`, `reset`, `thread_reset` (the team reset the conversation: the chat empties, the draft and outbox stay, the socket stays open), 4004 erase. Only while the chat is open. |
| Read receipts, typing | `POST /thread/read` while visible; typing out at most every 3 s; dots only for a human teammate. |
| Parts and cards | Text (links), images (a photo retention deleted, `removed: true`, shows "Photo removed" and is never fetched), receipts (the AI teammate's `handed_off` hand-off line is a plain system line, without the check), system lines, the ping line, the AI label, offer, review, link, choices, rating, report, store action. Unknown parts and cards show `Message.fallback`. |
| Store actions | No StoreKit or Play Billing on the web: each action opens the store's web page (App Store or Google Play by the card's hint, else the device). `restore_purchases` shows its text only. |
| Review cards | Open `storeUrl`; there is no native prompt. |
| Bug reports | `reportBug()` for your own report form. No shake or screenshot markup: the report card focuses the composer, where people can paste a screenshot. |
| Push | Web push through the browser's Push API, after `enablePush()` (see [Web push](#web-push)). Without it, `GET /unread` is polled while the tab is visible. |
| Plans and offers | `setEntitlement` and `setOffers`, as on iOS and Android. The plan status line is not drawn on the web. |
| Team actions | Same: `on("teamAction")`, each id once, live or caught up after a reconnect. |
| Conversation state | The widget is UI-only: it draws its own chat, so there is no headless conversation API (`isServerUnreachable`, pending and held messages, `markRead`, an awaitable `reload`) as on iOS, Android and the bridges, and `close()` is synchronous. |
| Device context | Not sent: the web SDK adds no build, display, connection, health or notification context. The server still derives a coarse place from the request address, as for every SDK, and never stores the address. |
| Look | `GET /config` (ETag, 5 minutes, `config` events) resolved field by field: dashboard, then `appearance`, then defaults; the iOS SDK's contrast rules. |
| Configuration problems | A bad key, an unknown key or a refused origin logs an error, emits `problem`, and shows the exact problem in the chat on localhost (or with `debug: true`); production pages show a neutral line. |

## Layout and accessibility

- A custom element (`pingfront-chat`) with a shadow root; host CSS can't change it (the example page uses a hostile stylesheet).
- Content-Security-Policy: no `eval`, no inline styles. The stylesheet is a constructed `CSSStyleSheet` and
  sizes go through the CSSOM, so a page with `style-src 'self'` needs nothing added for styles; allow the API
  in `connect-src` (`https://api.pingfront.sh`, its `wss://` live socket and the photo upload host) and, in
  `img-src`, the photo and avatar hosts plus `blob:` (previews of picked photos). The [lazy modules](#lazy-modules)
  are scripts from the script's own folder: a `script-src` that allows `pingfront.js` by its host allows them, and
  under a nonce-based policy they carry the script tag's `nonce`.
  `test/hosting.browser.test.ts` checks this in Chrome, and that a tag in `<head>` without `defer` waits for `<body>`.
- iMessage metrics at 1 pt = 1 px: 18 px radius, 12 × 7.5 px padding,
  2 px within a group, 9 px between groups, tails on the last bubble. pingfront's own values (the ping dot,
  the leaf check, radii, shadows, motion, the focus ring) are pingfront's design tokens (`src/ui/tokens.json`),
  injected at build time.
- The panel is a modal dialog with a focus trap; Escape closes and returns focus. New messages are announced in
  a polite live region. Reduced motion stops the animations. Text colors are pushed to 4.5:1.
- Under 560 px wide the panel is a full-screen sheet and the page behind it stops scrolling.
- On-screen keyboards shrink the visual viewport, not the layout viewport `position: fixed` uses (Chrome on
  Android by default, Safari on iOS, which also scrolls the page). While the chat shows, the panel follows the
  visual viewport, so the composer sits flush on the keyboard and the header stays in view; pinch zoom is left alone.
- States, in the native SDKs' words: a still skeleton while the thread loads; offline is a bar under the header, as
  on iOS and Android, above a usable composer (the outbox sends when the network is back, and the thread loads then),
  and a waiting message reads "Waiting for connection"; online but unable to reach the service, the bar says "Can't
  reach the chat right now. Messages will send when it's back." and a waiting message reads "Not sent yet. Trying
  again soon." An open chat tries again after 10 s, and the first answer from the service (to any request) clears
  the bar and loads what the chat is missing: the config, then the thread, or the messages it missed. While the
  chat is open and the app is paused, it checks `GET /thread` once a minute and sends nothing else, so a resume
  shows without reopening. A message the server already answered with shows once, never also as unsent. A server failure while online is "Couldn't load the conversation." with
  "Try again"; a key or origin problem is one centered line and no composer.
- The send policy is the one source of truth for whether the person can send. When it is closed (blocked, paused,
  sign in), whether from `GET /thread` or from a refused send, its notice takes the composer's place ("This chat is
  paused for now.") and the welcome promises no reply. As on iOS, only a pause or a required sign-in holds a message:
  it gets no error mark, and one muted line under the last of a run says "Not sent yet. It will send when the chat is
  back." or "Not sent yet. It will send after you sign in."; the queue is strict, so a held message keeps the ones
  behind it waiting. It sends by itself, first and in order, when sending reopens: for a pause, after any successful
  `GET /unread` or `GET /thread`; for a sign-in, once `identify` makes the person verified (even with the chat
  closed). A held bubble is a disclosure button (WAI-ARIA APG) that shows Delete. A blocked person is promised
  nothing: a refused message, and the ones queued behind it, read "Not delivered" with Delete only, and turning
  blocked makes held messages plain failures. A rate limit says "You can send again in 0:40." under 5 minutes (announced once to screen
  readers; the ticking digits are not a live region), then "Sending is paused for a while. Try again later." A
  message waiting out a rate limit or a server error reads "Not sent yet. Trying again soon." While only photos are
  rate limited, the notice says "Photos can be sent again in 0:40. Text still sends." and text behind a photo goes
  out, as on iOS. Signing in (`identify(token)`) where the chat asked for it loads the thread again and opens sending.
  After the person's first message and before any reply, a muted line says "You can close this; the reply waits
  here.", never while a message still waits to send (the header already says when to expect a reply).
- Each fact once, as on iOS and Android: until there is a conversation the welcome carries the face, the name and
  the reply expectation, and the close button floats over it with no header bar. A message that can't be sent says
  "Not delivered", with the reason when there is one in the person's language (a photo or text problem, never the
  send policy's, which the notice says while it holds and which is no longer true once sending reopens). As in
  Messages, a mark beside the bubble (a WAI-ARIA APG disclosure) shows its actions: "Try again" when the person may
  send and sending again can work (after a policy refusal, or a refused upload), and "Delete". Older offer cards
  collapse to "Replaced by a newer offer", and an offer whose paywall the app reports gone or unavailable
  (`setOffers`) stays in the thread with its title muted and no button, saying "This offer is no longer available." A card that can't act on the page (an offer with no `onOffer`, a review with no store page, a deep link with no
  `onLink`) shows "Not available in this app" where its button would be, as on iOS; restoring purchases says where to
  do it instead. Topics show only when the person can send.
- Focus follows the WAI-ARIA APG dialog pattern: opening moves focus to the dialog itself, not the composer (as the
  native SDKs don't raise the keyboard), a topic puts the caret in the composer, and focus never leaves the dialog
  when the composer goes away. Embedded, opening never moves focus.
- Keyboard focus is one 3 px sky outline everywhere, 2 px outside the control; the composer field's outline is drawn
  inside it, over its own border, so the field shows one outline, not two; controls drawn smaller than 44 px (the
  +, the ping line, "Load earlier messages", a failed message's mark, Try again and Delete) keep a 44 px target. The rating is a group of five buttons with a roving
  tabindex: one tab stop, arrow keys move, Space or Enter rates.
- The thread's indicator is the widget's own: a thin thumb in the look's muted ink, shown while the
  thread moves and gone when it rests, like the overlay indicators iOS draws. The browser's scrollbar
  is hidden, because it cannot take the app's palette and sat on top of the panel's edge.
- On pingfront's Free plan (`features.branding`) the welcome carries our one-colour lockup on its own
  bar above the composer: 14 px, faded, in the look's muted ink. It is drawn from the brand's outlines
  (`src/ui/lockup.ts`), so the host's font never changes its letters, and `aria-label` carries the
  localized "Chat by pingfront". It never appears inside a conversation. The outlines aren't in the first load: the
  npm build imports them as a chunk, and the script fetches `locales/lockup.json` next to itself, checked against
  the packs' integrity manifest. The welcome waits for them behind the still skeleton, so it never shows without the
  lockup and nothing moves when it arrives; if they can't load, the bar says "Chat by pingfront" in text.

## Lazy modules

What runs only once someone opens the chat, or hardly ever, is not in the first load: the live socket
(`src/lazy/live.ts`, when the chat opens), the self-check, the web push flows (`enablePush`, `disablePush`, a
subscription's resync and removal). `core/modules.ts` loads each
once, the first time it runs.

- The npm build imports each as a chunk the host's bundler serves.
- The script build writes each to `dist/locales/<name>.js`, listed with its SHA-384 in `locales/manifest.json`, and
  runs it as a script element with that integrity (`crossorigin="anonymous"`, the widget's nonce). The module hands
  its exports to the loader through an event on its own element, so nothing is added to the page's globals.
- A module takes the widget's classes and state as arguments (the engine itself) and imports only types and the
  stateless helpers in `core/decode.ts` and `core/runtime.ts`; `vite.config.ts` fails the build otherwise, because the
  script build's copy is a separate script.
- The chat never waits for one: the thread loads over HTTP while the socket loads, and the socket connects once it
  is there. A module that can't load (a blocked or missing `locales/` folder) leaves the chat as it is without it:
  no live updates (replies arrive on reload, as where WebSockets are unavailable), `enablePush()` resolves
  `"failed"` and `selfCheck()` fails with `module_blocked`. Each logs why.

## Languages

The widget's own text ships in the 50 languages of
[`docs/localization-locales.md`](https://pingfront.sh/docs/localization), with its glossary. The `locale`
option (default: the browser's language) is normalized to one of them (`es-MX` is `es-419`, `zh-TW`
is `zh-Hant`, `zh-HK` and `zh-MO` are `zh-HK`, `fr-CA` is `fr-CA`, `iw` is `he`), then its base language, then
English. Arabic, Hebrew, Persian and Urdu
set `dir="rtl"` on the chat; other languages follow the host page's direction.

- English is built in (`src/locales/en.json`); every other language is a pack `src/locales/<tag>.json`
  with the same keys: templates with `{app}`, `{name}`, `{time}`, `{n}`, and plurals as objects keyed by
  `Intl.PluralRules` category. `test/locales.test.ts` checks keys, placeholders, categories and that
  nothing is left in English.
- The npm build imports packs as lazy chunks (`import.meta.glob`), served by the host's bundler.
- The script build writes them to `dist/locales/` with `locales/manifest.json` (each pack's SHA-384)
  and carries only the manifest's SHA-384. It fetches `locales/` next to its own URL, without
  credentials and with Subresource Integrity on both files; the `v1` alias loads its exact version's
  packs. A pack that doesn't load or verify leaves the chat in English.
- The pack loads once, when the chat is created; English pages fetch nothing. The launcher shows English
  for the moment before it arrives, then every label switches.

## Develop

```sh
pnpm install
pnpm check      # typecheck, lint, tests, build, size budget
```

| Task | Command |
| --- | --- |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` (oxlint, no warnings) |
| Unit tests | `pnpm test` (Vitest, jsdom, fake IndexedDB). The 8 browser tests run with `WIDGET_BROWSER=1` and Chrome (`CHROME=/path` overrides it) |
| Build | `pnpm build`: `dist/index.js` (ES module, with its chunks), `dist/pingfront.js` (script), `dist/pingfront-sw.js` (the push service worker), `dist/types`, and `dist/locales` (the language packs and lazy modules) |
| Size budget | `pnpm size`: the script must stay at or under 40 KB gzipped (39.8 KB on 10 November 2026; the ES module 41.4 KB, not budgeted). The lazy modules are listed beside it, outside the budget: live 2.9 KB, push 1.3 KB, self-check 0.9 KB |
| Examples | `pnpm build`, then `EXAMPLE_KEY=pk_test_… pnpm example` with your app's public key (Dashboard › App › Connect) and `http://localhost:5204` in its web origins: `http://localhost:5204/` (one script tag) and `http://localhost:5204/react/` (Vite and React). `EXAMPLE_API` points them at another server |

`src/core/wire.ts` (the wire types), `src/core/keys.ts` (the offline key check) and `src/ui/tokens.json` (the design
tokens) are generated from pingfront's contract and design tokens; don't edit them by hand. The contract's
conformance tests (decoders against its fixtures, the shared behaviour scenarios) run in pingfront's CI.

The product's names (global, element, storage, SDK name) live only in `src/constants.ts`. Class members are ES
private fields (`#name`), which the minifier can rename; keep new ones private unless the public API needs them.
