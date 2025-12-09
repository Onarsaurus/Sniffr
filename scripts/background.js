// scripts/background.js (module or plain)
// This file exposes chrome.runtime.onMessage to handle "server-rank" requests from popup.
// It forwards the request to your Vercel endpoint.

const VERCEL_URL = "https://sniffr-gamma.vercel.app/api/sniffr-proxy"; // <-- REPLACE with your deployment

async function proxyToServer(body) {
  const resp = await fetch(VERCEL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // note: network errors will throw
  return resp.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "server-rank") {
    (async () => {
      try {
        const resp = await proxyToServer({
          query: message.query,
          candidates: message.candidates,
        });
        sendResponse({ ok: true, server: resp });
      } catch (err) {
        console.error("server-rank error:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async
  }
});
