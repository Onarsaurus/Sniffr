// api/sniffr-proxy.js
// Vercel Serverless Function (Node.js)
// Minimal, opinionated proxy: accepts POST { query, candidates }
// Calls OpenAI and returns { ok:true, parsed, raw } where parsed is the assistant JSON (index, reason)

const OPENAI_URL = "https://api.openai.com/v1/chat/completions"; // chat completions endpoint
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // change if needed
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY; // set this in Vercel

// Basic in-memory cache + rate-limiter (ephemeral per server instance)
const CACHE = new Map(); // key -> { value, expiresAt }
const RATE = new Map();  // ip -> { count, resetAt }
const MAX_PER_WINDOW = 120; // max requests per IP per window
const WINDOW_MS = 60 * 1000; // 1 minute window
const CACHE_TTL_MS = 30 * 1000; // 30s cache for identical queries (hobby)

function now() { return Date.now(); }

function getClientIp(req) {
  // Vercel may forward via x-forwarded-for
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  // fallback to connection remoteAddress (may not be available)
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (e.expiresAt < now()) { CACHE.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  CACHE.set(key, { value, expiresAt: now() + ttl });
}

function rateCheck(ip) {
  const entry = RATE.get(ip);
  const t = now();
  if (!entry || entry.resetAt < t) {
    RATE.set(ip, { count: 1, resetAt: t + WINDOW_MS });
    return { ok: true, remaining: MAX_PER_WINDOW - 1, resetAt: t + WINDOW_MS };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    return { ok: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { ok: true, remaining: MAX_PER_WINDOW - entry.count, resetAt: entry.resetAt };
}

async function callOpenAI(prompt) {
  if (!OPENAI_KEY) throw new Error("OPENAI_KEY environment variable is not set on server.");
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content:
`You are "Sniffr", a tiny assistant whose job is to pick which candidate (from a short enumerated list) best matches the user's short query.
Be extremely terse and always return ONLY a JSON object (no surrounding text). The JSON MUST be parseable.
Return this shape exactly:
{"index": <best_index_or_-1>, "reason": "<one-sentence reason, 1-2 sentences max>"}

If there is no good match return index:-1 and a short reason.
` },
      { role: "user", content: prompt }
    ],
    temperature: 0.0,
    max_tokens: 200
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify(body),
    // set a short timeout at fetch level? not available natively here, Vercel will timeout itself.
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const assistant = data?.choices?.[0]?.message?.content || "";
  return { raw: assistant, data };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    // Basic rate-limit by IP
    const ip = getClientIp(req);
    const rate = rateCheck(ip);
    if (!rate.ok) {
      res.setHeader("Retry-After", Math.ceil((rate.resetAt - now()) / 1000));
      res.status(429).json({ ok: false, error: "Rate limit exceeded" });
      return;
    }

    // Parse body
    const { query, candidates } = req.body || {};
    if (!query || !Array.isArray(candidates)) {
      res.status(400).json({ ok: false, error: "Bad request: expected JSON { query, candidates[] }" });
      return;
    }

    // compose a small key for caching
    const key = JSON.stringify({ q: query, c: candidates.slice(0, 60).map(c => ({t: c.text || "", h: c.href || ""})) });
    const cached = cacheGet(key);
    if (cached) {
      res.status(200).json({ ok: true, cached: true, ...cached });
      return;
    }

    // Build compact prompt: enumerated candidates
    const lines = [
      `User query: "${String(query).replace(/\n/g, " ")}"`,
      `Candidates (index | type | label | href):`
    ];
    for (let i = 0; i < Math.min(candidates.length, 80); i++) {
      const c = candidates[i] || {};
      const label = String(c.text || "").replace(/\n/g, " ").slice(0, 240);
      const href = c.href || "(no href)";
      lines.push(`${i} | ${c.type || ""} | "${label}" | ${href}`);
    }
    lines.push(`Return JSON ONLY: {"index": <best_index_or_-1>, "reason":"brief 1-2 sentence reason"}`);
    const prompt = lines.join("\n");

    // call OpenAI
    const openaiResp = await callOpenAI(prompt);
    const assistantText = openaiResp.raw;

    // try to parse JSON substring
    let parsed = null;
    const s = assistantText || "";
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end >= start) {
      try {
        parsed = JSON.parse(s.slice(start, end + 1));
      } catch (e) {
        parsed = null;
      }
    }

    const result = { raw: assistantText, parsed };
    cacheSet(key, result, CACHE_TTL_MS);

    res.status(200).json({ ok: true, cached: false, ...result });
  } catch (err) {
    console.error("sniffr-proxy error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
