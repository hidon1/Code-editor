/**
 * CodeSphere AI Worker — Cloudflare Worker
 * Secure xAI proxy for CodeSphere editor
 *
 * Routes:
 *   GET  /api/health
 *   POST /api/generate  { prompt, projectContext? }
 *   POST /api/improve   { files, instruction, history?, projectContext? }
 *   POST /api/chat      { message, files?, history?, projectContext? }
 *
 * Required env vars:
 *   XAI_API_KEY
 * Optional env vars:
 *   ALLOWED_ORIGIN (default: *)
 *   XAI_MODEL (default: grok-3-mini-fast)
 */

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MAX_TOKENS = 16000;
const MAX_HISTORY = 12;

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
  (אלא אם הפרויקט קטן מאוד — אז קובץ HTML אחד עם style+script בפנים)
• כתוב קוד ייצורי מלא — לא סקיצות
• עיצוב מודרני: CSS variables, grid, flexbox, animations, transitions
• RTL מלא עם dir="rtl" ו-font-family: 'Heebo', 'Assistant', sans-serif (Google Fonts)
• JS: Vanilla בלבד ללא frameworks (אלא אם התבקש)
• תמיכה מלאה במובייל — responsive design
• אל תוסיף כפתורי הורדה
`.trim();

function detectMotzarella(messages, projectContext = {}) {
  const allText = messages.map(m => String(m?.content || '')).join('\n').toLowerCase();
  const ctxText = JSON.stringify(projectContext).toLowerCase();
  const combined = `${allText} ${ctxText}`;

  const keywords = [
    'מוצרלה', 'motzarella', 'api=json', 'api=styled',
    'data-uid', 'widget.js', 'motzarella:add-to-cart',
    'product-manager', 'uid=', 'fields=content'
  ];

  const detected = keywords.some(k => combined.includes(k));
  const uidMatch = combined.match(/uid[=:\s]+["']?([a-z0-9]{20,})/i);
  const uid = uidMatch ? uidMatch[1] : (projectContext.motzarellaUid || '');

  const urlMatch = combined.match(/https?:\/\/[^\s"']+product-manager[^\s"']*/i);
  const baseUrl = urlMatch
    ? urlMatch[0].split('?')[0]
    : (projectContext.motzarellaBaseUrl || 'https://product-manager-a084a.web.app/index.html');

  const wantsCart = /סל|cart|קנייה|קניות|הוסף לסל/.test(combined);
  return { detected, uid, baseUrl, wantsCart };
}

function buildMotzarellaPrompt(motz) {
  if (!motz.detected) return '';

  const uid = motz.uid || 'YOUR_MOTZARELLA_UID';
  const baseUrl = motz.baseUrl || 'https://product-manager-a084a.web.app/index.html';

  return `
═══ מוצרלה (Motzarella) — אינטגרציה ═══
UID: ${uid}
BASE: ${baseUrl}

Endpoints:
  רשימת מוצרים: \`\${BASE}?api=json&uid=${uid}&fields=content\`
  מוצר בודד:    \`\${BASE}?api=json&productId={ID}\`
  Widget:        <div id="motzarella-store" data-uid="${uid}"></div>
                 <script src="${baseUrl.replace('/index.html', '')}/widget.js"></script>

שדות מוצר: id, name, price, currency, saleActive, salePrice,
  shortDescription, imageUrl, imageUrls[], tags[], variants[],
  accentColor, cardBackground, textColor, cartButtonText

חישוב מחיר: saleActive ? salePrice : price
מטבע: { ILS:'₪', USD:'$', EUR:'€' }[currency]

${motz.wantsCart ? `
סל קניות (חובה לממש):
  • שמור מצב ב-localStorage: 'motzarella_cart'
  • badge עם כמות פריטים
  • Drawer מהצד ימין עם רשימת פריטים
  • שורה לכל פריט: תמונה + שם + ×כמות + מחיר
  • כפתורי +/- לכמות
  • סה"כ ו-"המשך לתשלום"
  • סגירה ב-overlay click
  • שלח window.dispatchEvent(new CustomEvent('motzarella:checkout', { detail: cart }))
` : ''}
`.trim();
}

function buildMessages(userContent, history = [], motz = {}) {
  const motzSection = buildMotzarellaPrompt(motz);
  const systemFull = motzSection ? `${SYSTEM_PROMPT}\n\n${motzSection}` : SYSTEM_PROMPT;
  const normalizedHistory = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'assistant' || m.role === 'user') && typeof m.content === 'string')
        .slice(-MAX_HISTORY)
    : [];

  return [
    { role: 'system', content: systemFull },
    ...normalizedHistory,
    { role: 'user', content: userContent }
  ];
}

function guessLanguage(filename = '') {
  if (filename.endsWith('.css')) return 'css';
  if (filename.endsWith('.js')) return 'javascript';
  if (filename.endsWith('.html')) return 'html';
  return 'html';
}

async function callXAI(env, messages) {
  if (!env.XAI_API_KEY) {
    throw new Error('חסר XAI_API_KEY בסביבת ה-Worker');
  }

  const res = await fetch(XAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.XAI_MODEL || 'grok-3-mini-fast',
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.25,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => String(res.status));
    throw new Error(`xAI שגיאה ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ה-AI החזיר JSON לא תקני. נסה שוב.');
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('התשובה לא מכילה קבצים. נסה שוב.');
  }

  parsed.files = parsed.files.map(file => ({
    name: String(file?.name || 'index.html'),
    language: String(file?.language || guessLanguage(file?.name || '')),
    content: String(file?.content || '')
  }));

  return { ...parsed, usage: data?.usage || {} };
}

function apiOk(data) { return jsonRes({ ok: true, ...data }, 200); }
function apiError(message, status = 400) { return jsonRes({ ok: false, error: message }, status); }
function jsonRes(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

async function parseBody(request) {
  return request.json().catch(() => ({}));
}

async function handleGenerate(request, env) {
  const body = await parseBody(request);
  if (!body.prompt || !String(body.prompt).trim()) return apiError('"prompt" נדרש');

  const motz = detectMotzarella([{ content: body.prompt }], body.projectContext || {});
  const messages = buildMessages(String(body.prompt).trim(), [], motz);
  const result = await callXAI(env, messages);
  return apiOk(result);
}

async function handleImprove(request, env) {
  const body = await parseBody(request);
  if (!Array.isArray(body.files) || body.files.length === 0) return apiError('"files" נדרש');
  if (!body.instruction || !String(body.instruction).trim()) return apiError('"instruction" נדרש');

  const filesBlock = body.files.map(file => `=== ${file.name} ===\n${file.content || ''}`).join('\n\n');
  const motz = detectMotzarella(
    [{ content: body.instruction }, ...((body.history || []).slice(-4))],
    body.projectContext || {}
  );

  const userMsg = `הקוד הנוכחי:\n\n${filesBlock}\n\n---\nהוראה: ${String(body.instruction).trim()}`;
  const messages = buildMessages(userMsg, body.history || [], motz);
  const result = await callXAI(env, messages);
  return apiOk(result);
}

async function handleChat(request, env) {
  const body = await parseBody(request);
  if (!body.message || !String(body.message).trim()) return apiError('"message" נדרש');

  const filesBlock = (body.files || [])
    .map(file => `=== ${file.name} ===\n${file.content || ''}`)
    .join('\n\n');

  const context = filesBlock ? `קוד נוכחי:\n\n${filesBlock}\n\n---\n` : '';
  const motz = detectMotzarella(
    [{ content: body.message }, ...((body.history || []).slice(-4))],
    body.projectContext || {}
  );

  const userMsg = `${context}${String(body.message).trim()}`;
  const messages = buildMessages(userMsg, body.history || [], motz);
  const result = await callXAI(env, messages);
  return apiOk(result);
}

function withCors(response, cors) {
  const out = new Response(response.body, response);
  Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
  return out;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    try {
      let response;

      if (request.method === 'GET' && pathname === '/api/health') {
        response = apiOk({
          model: env.XAI_MODEL || 'grok-3-mini-fast',
          timestamp: new Date().toISOString()
        });
      } else if (request.method === 'POST' && pathname === '/api/generate') {
        response = await handleGenerate(request, env);
      } else if (request.method === 'POST' && pathname === '/api/improve') {
        response = await handleImprove(request, env);
      } else if (request.method === 'POST' && pathname === '/api/chat') {
        response = await handleChat(request, env);
      } else {
        response = apiError(
          `נתיב לא קיים: ${request.method} ${pathname} | GET /api/health · POST /api/generate · POST /api/improve · POST /api/chat`,
          404
        );
      }

      return withCors(response, cors);
    } catch (error) {
      const response = apiError(error?.message || 'שגיאת שרת', 500);
      return withCors(response, cors);
    }
  }
};
