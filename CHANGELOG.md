# Changelog

## 1.0.0

The first release of pingfront for the web, as the npm package `@pingfront/web-widget` and a single script on
`https://cdn.pingfront.sh/web/1.0.0/pingfront.js`.

- The in-app chat in a custom element with a shadow root: floating with a launcher, or embedded in your layout
  with `container`. Text, photos, receipts, the ping line, the AI label, and offer, review, link, choices, rating,
  report and store action cards.
- Nothing is sent when the page loads: a session starts with the person's first action, such as opening the chat.
- An outbox that keeps messages and photos in IndexedDB, sends them in order and retries safely.
- Live updates while the chat is open, read receipts and typing.
- `identify`, `setTraits`, `logout`, `eraseMyData`, `exportMyData`, `setEntitlement` and `setOffers`.
- Moments, offer cards (`onOffer`), links (`onLink`), chat links (`?pingfront=chat`) and saved links into your
  app's screens (`registerScreens`, `onScreen`).
- Web push for people, with `enablePush`, `disablePush` and the `pingfront-sw.js` service worker.
- Bug reports with `reportBug`, team actions with `on("teamAction")`, and `selfCheck()`.
- The look from the dashboard, with `appearance` for the fields it leaves unset.
- 50 languages, loaded on demand, and right-to-left layouts.
- Works under a strict Content-Security-Policy: no `eval` and no inline styles.
