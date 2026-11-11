// The React example: configure once at startup, then use the API from components. The chat renders
// itself (a custom element on document.body), so there is no component to mount.
import { PingFront, type OfferRequest } from "@pingfront/web-widget";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

/** Your app's key and the API, from EXAMPLE_KEY and EXAMPLE_API (example/vite.config.ts). */
declare const __PF_EXAMPLE_API__: string;
declare const __PF_EXAMPLE_KEY__: string;

PingFront.configure(__PF_EXAMPLE_KEY__, {
  baseUrl: __PF_EXAMPLE_API__,
  launcher: false,
  appName: "Clockwise",
  topics: [
    { id: "billing", label: "Ask about billing", symbol: "billing" },
    { id: "bug", label: "Report a bug", symbol: "bug" },
  ],
});

function useUnread(): number {
  const [n, setN] = useState(PingFront.unreadCount);
  useEffect(() => PingFront.onUnreadCount(setN), []);
  return n;
}

function App() {
  const unread = useUnread();
  const [offer, setOffer] = useState<OfferRequest | null>(null);
  useEffect(() => {
    PingFront.onOffer(setOffer);
    return () => PingFront.onOffer(null);
  }, []);
  return (
    <main style={{ maxWidth: 640, margin: "48px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Clockwise</h1>
      <p>The React example. The help button is the app's own; the chat opens on top.</p>
      <button type="button" id="help" onClick={() => PingFront.open()}>
        Help{unread > 0 ? ` (${unread})` : ""}
      </button>{" "}
      <button type="button" onClick={() => PingFront.open({ topic: "billing" })}>
        Ask about billing
      </button>
      {offer && (
        <div role="dialog" aria-label="Paywall" id="paywall" style={{ marginTop: 24, padding: 20, border: "1px solid #ccc", borderRadius: 12 }}>
          <h2>Clockwise Pro</h2>
          <p>Opened from the offer card {offer.title}.</p>
          <button type="button" onClick={() => setOffer(null)}>
            Close
          </button>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
