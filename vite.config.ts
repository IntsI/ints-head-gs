import { defineConfig, loadEnv, type Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Local dev proxy: keeps API keys SERVER-SIDE (read from .env, never shipped to
// the browser, never committed). Exposes /api/chat (Gemini) and /api/tts (Google
// Cloud TTS with SSML <mark> timepoints). See .env.example for the keys to fill.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // all vars incl. non-VITE_ (server-only)
  return {
    base: "./",
    server: { host: "0.0.0.0" },
    plugins: [devApi(env)],
  };
});

const GEMINI_MODEL = "gemini-2.0-flash";
const TTS_VOICE = "en-US-Neural2-D"; // natural US male; change languageCode/name to taste
// emotions Gemini may pick — must be keys the driver's RECIPES support
const EMOTIONS = [
  "neutral", "smile", "beam", "suspicious", "smug",
  "shock", "unimpressed", "angry", "sad", "disgust",
];
const SYSTEM_PROMPT =
  "You are a friendly, concise conversational talking head. Answer in 1-3 short, " +
  "natural spoken-style sentences (no markdown, no lists). Also pick the single " +
  "emotion that best fits your reply.";

function devApi(env: Record<string, string>) {
  return {
    name: "dev-api",
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use("/api/chat", wrap((req, res) => chat(req, res, env)));
      server.middlewares.use("/api/tts", wrap((req, res) => tts(req, res, env)));
    },
  };
}

// ---- helpers --------------------------------------------------------------
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
function wrap(h: Handler): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    h(req as IncomingMessage, res as ServerResponse).catch((e) =>
      sendJson(res as ServerResponse, 500, { error: `proxy error: ${(e as Error).message}` }),
    );
  };
}
function sendJson(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ---- /api/chat → Gemini ---------------------------------------------------
async function chat(req: IncomingMessage, res: ServerResponse, env: Record<string, string>) {
  const key = env.GEMINI_API_KEY;
  if (!key) return sendJson(res, 500, { error: "GEMINI_API_KEY is empty — paste it into .env (GEMINI_API_KEY=…) and restart the dev server." });

  const { text } = await readJson(req) as { text?: string };
  if (!text || !text.trim()) return sendJson(res, 400, { error: "no input text" });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          reply: { type: "string" },
          emotion: { type: "string", enum: EMOTIONS },
        },
        required: ["reply", "emotion"],
      },
    },
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const detail = await r.text();
    return sendJson(res, r.status, { error: `Gemini ${r.status}: ${detail.slice(0, 400)}` });
  }
  const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed: { reply?: string; emotion?: string } = {};
  try { parsed = JSON.parse(raw); } catch { parsed = { reply: raw, emotion: "neutral" }; }
  const emotion = EMOTIONS.includes(parsed.emotion ?? "") ? parsed.emotion : "neutral";
  sendJson(res, 200, { reply: parsed.reply ?? "", emotion });
}

// ---- /api/tts → Google Cloud TTS (audio + word timepoints) ----------------
async function tts(req: IncomingMessage, res: ServerResponse, env: Record<string, string>) {
  const key = env.GOOGLE_TTS_API_KEY;
  if (!key) return sendJson(res, 500, { error: "GOOGLE_TTS_API_KEY is empty — paste it into .env (GOOGLE_TTS_API_KEY=…) and restart the dev server." });

  const { text } = await readJson(req) as { text?: string };
  if (!text || !text.trim()) return sendJson(res, 400, { error: "no text to speak" });

  // split into words; insert an SSML <mark> before each so TTS reports word timing
  const words = text.trim().split(/\s+/);
  const ssml = "<speak>" +
    words.map((w, i) => `<mark name="w${i}"/>${xmlEscape(w)} `).join("") +
    "</speak>";

  const url = `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${key}`;
  const body = {
    input: { ssml },
    voice: { languageCode: "en-US", name: TTS_VOICE },
    audioConfig: { audioEncoding: "MP3" },
    enableTimePointing: ["SSML_MARK"],
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const detail = await r.text();
    return sendJson(res, r.status, { error: `Google TTS ${r.status}: ${detail.slice(0, 400)}` });
  }
  const data = await r.json() as { audioContent?: string; timepoints?: Array<{ markName: string; timeSeconds: number }> };
  sendJson(res, 200, {
    audioContent: data.audioContent ?? "",      // base64 MP3
    timepoints: data.timepoints ?? [],          // [{markName:'w0', timeSeconds}]
    words,                                       // aligned with the marks
  });
}
