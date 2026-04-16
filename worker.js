/**
 * CodeSphere AI Worker — Cloudflare Worker
 * Routes:
 *   GET  /api/health
 *   POST /api/generate
 *   POST /api/improve
 *   POST /api/chat
 *
 * Secrets (Cloudflare):
 *   XAI_API_KEY (Secret)
 * Optional vars:
 *   ALLOWED_ORIGIN (e.g. https://your-site.web.app)
 *   XAI_MODEL (default: grok-3-mini-fast)
 */

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const MODEL = "grok-3-mini-fast";
const MAX_TOKENS = 16000;
const MAX_HISTORY = 200;

const SYSTEM_PROMPT = `
אתה מפתח אתרים AI מומחה בתוך עורך הקוד CodeSphere.
המשימה שלך: לבנות, לערוך, ולשפר אתרי HTML/CSS/JavaScript.

═══ מה מותר לטפל ═══
• בניית אתרים (HTML, CSS, JavaScript)
• שיפור עיצוב, תיקון באגים, הוספת פיצ'רים
• שאלות על קוד וב-web development
• אינטגרציה עם שירותי חיצוניים (APIs)

═══ מה אסור ═══
• שאלות שאינן קשורות לקוד ואתרים — סרב בנימוס ב-1 משפט

═══ פורמט פלט חובה ═══
תמיד החזר JSON תקני בלבד, ללא טקסט נוסף, בפורמט הזה:
{
  "files": [
    { "name": "index.html", "language": "html",       "content": "..." },
    { "name": "style.css",  "language": "css",        "content": "..." },
    { "name": "script.js",  "language": "javascript", "content": "..." }
  ],
  "description": "תיאור קצר של מה שנבנה"
}

═══ כללי קוד ═══
• פצל תמיד ל-3 קבצים נפרדים: index.html + style.css + script.js
• כתוב קוד ייצורי מלא — לא סקיצות
• עיצוב מודרני: CSS variables, grid, flexbox, animations, transitions
• RTL מלא עם dir="rtl" ו-font-family: 'Heebo', 'Assistant', sans-serif
• JS: Vanilla בלבד ללא frameworks (אלא אם התבקש)
• תמיכה מלאה במובייל — responsive design
`.trim();

function guessLanguage(filename = "") {
  if (filename.endsWith(".css")) return "css";
  if (filename.endsWith(".js")) return "javascript";
  if (filename.endsWith(".html")) return "html";
  return "html";
}

function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function apiOk(data) {
  return jsonRes({ ok: true, ...data }, 200);
}

function apiError(message, status = 400) {
  return jsonRes({ ok: false, error: message }, status);
}

function withCors(response, corsHeaders) {
  const out = new Response(response.body, response);
  Object.entries(corsHeaders).forEach(([k, v]) => out.headers.set(k, v));
  return out;
}

async function parseBody(request) {
  return request.json().catch(() => ({}));
}

function buildMessages(userContent, history = []) {
  const normalizedHistory = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === "assistant" || m.role === "user") &&
            typeof m.content === "string"
        )
        .slice(-MAX_HISTORY)
    : [];

  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...normalizedHistory,
    { role: "user", content: userContent },
  ];
}

function normalizeSingleActiveFile(files = []) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const first = files[0] || {};
  return [
    {
      name: String(first?.name || "index.html"),
      content: String(first?.content || ""),
    },
  ];
}

async function callXAI(env, request, messages) {
  // מפתח יכול להגיע מסודיות Cloudflare או מכותרת x-xai-api-key
  const apiKey =
    env.XAI_API_KEY ||
    request.headers.get("x-xai-api-key") ||
    "";
  if (!apiKey) {
    throw new Error("Missing xAI API key (set XAI_API_KEY secret or send x-xai-api-key header)");
  }

  const res = await fetch(XAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.XAI_MODEL || MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.25,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => String(res.status));
    throw new Error(`xAI error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage || {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI returned invalid JSON");
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("AI response missing files[]");
  }

  parsed.files = parsed.files.map((f) => ({
    name: String(f?.name || "index.html"),
    language: String(f?.language || guessLanguage(f?.name || "")),
    content: String(f?.content || ""),
  }));

  return { ...parsed, usage };
}

async function handleGenerate(request, env) {
  const body = await parseBody(request);
  if (!body.prompt?.trim()) return apiError('"prompt" is required', 400);

  const messages = buildMessages(body.prompt.trim(), []);
  const result = await callXAI(env, request, messages);
  return apiOk(result);
}

async function handleImprove(request, env) {
  const body = await parseBody(request);
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return apiError('"files" is required', 400);
  }
  if (!body.instruction?.trim()) {
    return apiError('"instruction" is required', 400);
  }

  const filesBlock = body.files
    .map((f) => `=== ${f.name} ===\n${f.content || ""}`)
    .join("\n\n");

  const userMsg = `הקוד הנוכחי:\n\n${filesBlock}\n\n---\nהוראה: ${body.instruction.trim()}`;
  const messages = buildMessages(userMsg, body.history ?? []);
  const result = await callXAI(env, request, messages);
  return apiOk(result);
}

async function handleChat(request, env) {
  const body = await parseBody(request);
  if (!body.message?.trim()) return apiError('"message" is required', 400);

  const requestedActiveFileName = String(body.activeFileName || "").trim();
  const chatFiles = normalizeSingleActiveFile(body.files ?? []);
  const activeFileName = requestedActiveFileName || String(chatFiles[0]?.name || "").trim();
  const filesBlock = chatFiles
    .map((f) => `=== ${f.name} ===\n${f.content || ""}`)
    .join("\n\n");

  const activeFileHint = activeFileName
    ? `הקובץ הפעיל לעריכה: ${activeFileName}\nיש להחזיר אותו מעודכן בתוך files[].\n\n`
    : "";
  const context = filesBlock ? `${activeFileHint}קוד נוכחי:\n\n${filesBlock}\n\n---\n` : activeFileHint;

  const userMsg = `${context}${body.message.trim()}`;
  const messages = buildMessages(userMsg, body.history ?? []);
  const result = await callXAI(env, request, messages);
  return apiOk(result);
}

function handleHealth(env) {
  return apiOk({
    model: env.XAI_MODEL || MODEL,
    timestamp: new Date().toISOString(),
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-xai-api-key",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    // route map עם 405 אמיתי
    const routes = {
      "/api/health": ["GET"],
      "/api/generate": ["POST"],
      "/api/improve": ["POST"],
      "/api/chat": ["POST"],
    };

    const allowedMethods = routes[pathname];
    if (!allowedMethods) {
      return withCors(apiError(`Route not found: ${pathname}`, 404), cors);
    }
    if (!allowedMethods.includes(request.method)) {
      return withCors(
        apiError(`Method ${request.method} not allowed for ${pathname}`, 405),
        cors
      );
    }

    try {
      let response;
      if (pathname === "/api/health") response = handleHealth(env);
      else if (pathname === "/api/generate") response = await handleGenerate(request, env);
      else if (pathname === "/api/improve") response = await handleImprove(request, env);
      else if (pathname === "/api/chat") response = await handleChat(request, env);

      return withCors(response, cors);
    } catch (e) {
      return withCors(apiError(e?.message || "Server error", 500), cors);
    }
  },
};
