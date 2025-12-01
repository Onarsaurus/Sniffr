// scripts/content.js

// --- Configuration ---
const MAX_CANDIDATES = 800;    // safety cap when scanning very large pages
const MAX_RESULTS = 5;        // how many top matches to return
const MIN_ACCEPT_SCORE = 8;   // matches below this are considered not found

// --- Helpers ---
function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // Offscreen entirely? still treat as visible (we may scroll to it)
  return true;
}

function getRegion(el) {
  let node = el;
  while (node && node !== document.body) {
    const tag = node.tagName ? node.tagName.toLowerCase() : "";
    const role = node.getAttribute ? (node.getAttribute("role") || "").toLowerCase() : "";

    if (tag === "nav" || role === "navigation") return "nav";
    if (tag === "header" || role === "banner") return "header";
    if (tag === "footer" || role === "contentinfo") return "footer";
    node = node.parentElement;
  }

  const rect = el.getBoundingClientRect();
  if (rect.top < window.innerHeight * 0.25) return "upper";
  return "body";
}

// normalize and pick readable text for an element
function extractText(el) {
  if (!el) return "";
  // common sources of readable label
  const props = [
    el.innerText,
    el.textContent,
    el.getAttribute && el.getAttribute("aria-label"),
    el.getAttribute && el.getAttribute("title"),
    el.getAttribute && el.getAttribute("alt"),
    el.getAttribute && el.getAttribute("value")
  ];
  for (const p of props) {
    if (p && typeof p === "string") {
      const t = p.trim();
      if (t) return t.replace(/\s+/g, " ");
    }
  }
  return "";
}

function shortSnippet(text, max = 80) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// --- Candidate collection ---
function getSearchCandidates() {
  const candidates = [];
  const seen = new Set();

  // Helper to push candidate once and avoid duplicates
  function pushCandidate(obj) {
    const key = (obj.type || "") + "|" + (obj.href || "") + "|" + (obj.text || "").slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(obj);
  }

  // Links (<a>)
  const anchors = Array.from(document.querySelectorAll("a"));
  for (const a of anchors) {
    if (!isVisible(a)) continue;
    const text = extractText(a);
    const href = a.href || a.getAttribute("href") || "";
    if (!text && !href) continue;
    pushCandidate({
      type: "link",
      text,
      href,
      element: a,
      region: getRegion(a),
      tagName: "a"
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // Buttons and button-like elements (button, input[type=submit|button], role=button)
  const buttons = Array.from(document.querySelectorAll("button, input[type=button], input[type=submit], [role='button']"));
  for (const b of buttons) {
    if (!isVisible(b)) continue;
    const text = extractText(b);
    const href = b.getAttribute && (b.getAttribute("href") || "");
    if (!text && !href) continue;
    pushCandidate({
      type: "button",
      text,
      href: href || null,
      element: b,
      region: getRegion(b),
      tagName: b.tagName ? b.tagName.toLowerCase() : "button"
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // Headings (h1..h6)
  const heads = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  for (const h of heads) {
    if (!isVisible(h)) continue;
    const text = extractText(h);
    if (!text) continue;
    pushCandidate({
      type: "heading",
      text,
      href: null,
      element: h,
      region: getRegion(h),
      tagName: h.tagName ? h.tagName.toLowerCase() : "h"
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

// --- Scoring function (returns numeric score) ---
function scoreCandidate(candidate, query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return 0;
  const text = (candidate.text || "").toLowerCase();
  const href = (candidate.href || "").toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  let score = 0;

  // exact and substring matches
  if (text === q) score += 22;
  if (text.includes(q)) score += 14;

  // per-word matches
  words.forEach((w) => {
    if (!w) return;
    if (text === w) score += 7;
    else if (text.includes(w)) score += 5;
    if (href.includes(w)) score += 3;
  });

  // href match
  if (href.includes(q)) score += 7;

  // nav-ish keywords
  const navKeywords = [
    "portal","login","log in","sign in","account","dashboard","student","admissions",
    "apply","register","registration","calendar","schedule","billing","payment","pay",
    "contact","support","help","courses","classes","portal"
  ];
  navKeywords.forEach((kw) => {
    if (!kw) return;
    if (text.includes(kw) || href.includes(kw)) score += 2;
    if (q.includes(kw) && (text.includes(kw) || href.includes(kw))) score += 3;
  });

  // structural bonuses
  switch (candidate.region) {
    case "nav": score += 11; break;
    case "header": score += 6; break;
    case "upper": score += 4; break;
    case "footer": score -= 5; break;
    default: break;
  }

  // prefer headings somewhat
  if (candidate.type === "heading") score += 3;

  // prefer concise labels
  const len = candidate.text ? candidate.text.length : 0;
  if (len > 0 && len <= 30) score += 5;
  else if (len > 70) score -= 3;

  // small penalty for generic 'click here' style (very short and vague)
  if (/click here|read more|learn more/i.test(candidate.text)) score -= 2;

  return score;
}

// --- Highlight helper (non-destructive) ---
function highlightElement(el) {
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { /* ignore */ }

  const prev = el.getAttribute("data-sniffr-prev-outline") || "";
  if (!prev) {
    el.setAttribute("data-sniffr-prev-outline", el.style.outline || "");
  }
  el.style.outline = "3px solid #ffa424";
  el.style.outlineOffset = "4px";

  // remove highlight after 2.5s
  setTimeout(() => {
    const prevOutline = el.getAttribute("data-sniffr-prev-outline");
    if (prevOutline !== null) {
      el.style.outline = prevOutline;
      el.removeAttribute("data-sniffr-prev-outline");
    }
  }, 2500);
}

// --- Main message handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "sniffr-search") return;

  const query = (message.query || "").toString().trim();
  if (!query) {
    sendResponse({ found: false, results: [] });
    return;
  }

  const candidates = getSearchCandidates();
  const scored = [];

  for (const c of candidates) {
    const s = scoreCandidate(c, query);
    if (s > 0) {
      scored.push({
        score: s,
        type: c.type,
        text: c.text,
        href: c.href || null,
        region: c.region,
        tagName: c.tagName,
        element: c.element
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // pick top N results above threshold
  const results = scored.filter(r => r.score >= MIN_ACCEPT_SCORE).slice(0, MAX_RESULTS);

  // If we have at least 1 result, highlight the best one
  if (results.length > 0) {
    // highlight the element referenced by the first result if it's still in DOM
    const best = results[0];
    if (best && best.element && document.contains(best.element)) {
      highlightElement(best.element);
    } else if (best && best.href) {
      // fallback: try to find an element by href if element reference is stale
      const foundByHref = document.querySelector(`a[href="${best.href}"]`);
      if (foundByHref) highlightElement(foundByHref);
    }

    // Prepare serializable results (can't send DOM nodes)
    const serial = results.map(r => ({
      score: r.score,
      type: r.type,
      text: shortSnippet(r.text, 120),
      href: r.href,
      region: r.region,
      tagName: r.tagName
    }));

    sendResponse({ found: true, results: serial });
  } else {
    sendResponse({ found: false, results: [] });
  }

  return true; // async response ok
});
