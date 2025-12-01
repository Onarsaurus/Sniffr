// scripts/popup.js
// Modern, robust popup logic that handles content.js -> response.results structure.

(() => {
  // ---- Utility: promisify chrome APIs ----
  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (!tabs || tabs.length === 0) return reject(new Error("No active tab found"));
          resolve(tabs[0]);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) {
            // Common case: some pages block extensions (chrome://, webstore, etc.)
            return reject(chrome.runtime.lastError);
          }
          resolve(resp);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---- DOM helpers ----
  const chatContainer = document.getElementById("chatContainer");
  const input = document.getElementById("searchInput");
  const sendBtn = document.getElementById("sendBtn");
  const inputBar = document.getElementById("inputBar");

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function createMessageElement({ contentNode, sender = "sniffr" }) {
    const message = document.createElement("div");
    message.classList.add("message", sender);

    const avatar = document.createElement("div");
    avatar.classList.add("avatar", sender === "user" ? "user-avatar" : "sniffr-avatar");

    const bubble = document.createElement("div");
    bubble.classList.add("bubble", sender === "user" ? "user-bubble" : "sniffr-bubble");

    if (contentNode instanceof Node) {
      bubble.appendChild(contentNode);
    } else {
      bubble.textContent = String(contentNode);
    }

    if (sender === "user") {
      message.appendChild(bubble);
      message.appendChild(avatar);
    } else {
      message.appendChild(avatar);
      message.appendChild(bubble);
    }

    return message;
  }

  function addMessage(content, sender = "sniffr") {
    const node = typeof content === "string" ? document.createTextNode(content) : content;
    const messageEl = createMessageElement({ contentNode: node, sender });
    chatContainer.appendChild(messageEl);
    scrollToBottom();
  }

  // Short helper to create a small badge for score
  function scoreBadge(score) {
    const span = document.createElement("span");
    span.className = "sniffr-score-badge";
    span.textContent = `${Math.round(score)}%`;
    span.setAttribute("aria-label", `Confidence ${Math.round(score)} percent`);
    return span;
  }

  // ---- Handle results returned from content script ----
  function renderResults(query, tabUrl, response) {
    // Clear previous Sniffr message area by appending a new bubble with results
    if (!response || !response.found || !Array.isArray(response.results) || response.results.length === 0) {
      addMessage(`I sniffed around but couldn't find anything matching "${query}" on this page. Try rephrasing or being more specific. 🐾`, "sniffr");
      return;
    }

    // Compose a fragment for the sniffr bubble
    const fragment = document.createDocumentFragment();

    // Intro text
    const intro = document.createElement("div");
    intro.textContent = `I found ${response.results.length} match${response.results.length > 1 ? "es" : ""}. Click a result to re-highlight it, or "Open" to open the link.`;
    fragment.appendChild(intro);

    // Results list
    const list = document.createElement("ol");
    list.className = "sniffr-results-list";
    list.style.paddingLeft = "16px";
    list.style.margin = "8px 0";

    response.results.forEach((r, i) => {
      const item = document.createElement("li");
      item.className = "sniffr-result-item";
      item.style.marginBottom = "6px";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "8px";

      // Label (text or href fallback)
      const label = document.createElement("button");
      label.type = "button";
      label.className = "sniffr-result-label";
      label.title = r.text || r.href || "Open";
      // Use textContent to prevent XSS
      label.textContent = r.text || r.href || "(no label)";
      label.style.background = "transparent";
      label.style.border = "none";
      label.style.padding = "0";
      label.style.cursor = "pointer";
      label.style.fontWeight = "600";
      label.style.color = "inherit";
      label.setAttribute("aria-label", `Highlight: ${label.textContent}`);

      // Clicking the label asks the content script to re-highlight this candidate
      label.addEventListener("click", async () => {
        try {
          addMessage(`Re-highlighting "${label.textContent}" for you...`, "sniffr");
          const tab = await queryActiveTab();
          // Resend the search with the label text or href to cause content.js to re-run scoring and highlight
          await sendMessageToTab(tab.id, { type: "sniffr-search", query: r.text || r.href || label.textContent });
        } catch (err) {
          addMessage("I couldn't re-highlight on this page (page may block extensions).", "sniffr");
        }
      });

      // Score badge (map score to 0-100 range visually)
      // content.js uses raw numeric values; convert to percentage for UX
      const percent = Math.min(100, Math.max(0, Math.round((r.score / 35) * 100))); // heuristic
      const badge = scoreBadge(percent);

      // Open button (if href exists)
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "sniffr-open-btn";
      openBtn.textContent = "Open";
      openBtn.setAttribute("aria-label", `Open ${label.textContent} in a new tab`);
      openBtn.style.marginLeft = "auto";
      openBtn.style.cursor = "pointer";

      openBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          const tab = await queryActiveTab();
          // If href is relative, resolve against current tab URL
          let url = r.href || "";
          try {
            url = new URL(url, tab.url).href;
          } catch (err) {
            // fallback: if can't resolve, just try using href as-is
            url = r.href;
          }
          if (url) {
            chrome.tabs.create({ url });
          } else {
            addMessage("No URL to open for that result.", "sniffr");
          }
        } catch (err) {
          addMessage("I couldn't open that link (permission or page restriction).", "sniffr");
        }
      });

      // Append elements into list item
      item.appendChild(label);
      item.appendChild(badge);
      item.appendChild(openBtn);

      list.appendChild(item);
    });

    fragment.appendChild(list);

    addMessage(fragment, "sniffr");
  }

  // ---- Main search flow ----
  async function performSearch(query) {
    if (!query || !query.trim()) return;
    const text = query.trim();

    // Add user bubble
    addMessage(text, "user");

    // Query the active tab and the content script (wrap in try/catch)
    try {
      const tab = await queryActiveTab();
      // Ask content script to search
      const response = await sendMessageToTab(tab.id, { type: "sniffr-search", query: text });

      // If content script returns results in the older single-object format, normalize it
      // Normalize to: { found: boolean, results: [{score, text, href, region, tagName}, ...] }
      let normalized = { found: false, results: [] };
      if (!response) {
        throw new Error("No response from content script");
      } else if (response.found && Array.isArray(response.results)) {
        normalized = response;
      } else if (response.found && response.text) {
        // legacy fallback: single result object
        normalized = {
          found: true,
          results: [{
            score: response.score || 20,
            text: response.text || response.href || "",
            href: response.href || null,
            region: response.region || null,
            tagName: response.tagName || null
          }]
        };
      } else {
        normalized = { found: !!response.found, results: response.results || [] };
      }

      renderResults(text, tab.url, normalized);
    } catch (err) {
      // Show friendly error to user (don't expose raw error to UI)
      console.error("Sniffr error:", err);
      addMessage("I couldn't sniff this page. Some pages block extensions (like the Chrome Web Store).", "sniffr");
    }
  }

  // ---- Event wiring ----
  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    performSearch(input.value || "");
  });

  inputBar.addEventListener("submit", (e) => {
    e.preventDefault();
    performSearch(input.value || "");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
    }
  });

  // ---- Initial greeting ----
  document.addEventListener("DOMContentLoaded", () => {
    addMessage("Hi, I’m Sniffr! Tell me what you're trying to find on this page (e.g. portal, login, contact).", "sniffr");
  });

})();
