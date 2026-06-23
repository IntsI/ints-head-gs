/**
 * Conversational loop orchestration:
 *   mic/text -> /api/chat (Gemini) -> reply + emotion
 *            -> /api/tts (Google TTS) -> audio + word timepoints
 *            -> play audio + speak(visemes from timepoints) + setExpression(emotion)
 *
 * Keys live server-side in the Vite dev proxy (see vite.config.ts / .env). This
 * file never sees them. Mic uses the browser's free Web Speech API (no key).
 */
import { visemesFromTimepoints, type VisemeSegment } from "./speech";

export interface ChatDeps {
  speak: (seq: VisemeSegment[]) => void;
  setExpression: (key: string) => void;
  onReply: (text: string) => void;                       // show the spoken reply
  onStatus: (msg: string, kind?: "" | "ok" | "err") => void;
  onTranscript: (text: string) => void;                  // mic heard this
  onMicState: (listening: boolean) => void;
}

export interface ChatHandle {
  send: (text: string) => Promise<void>;
  toggleMic: () => void;
  micSupported: boolean;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`can't reach ${url} — is the dev server running? (${(e as Error).message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${url} failed (${res.status})`);
  return data as Record<string, unknown>;
}

export function createChat(deps: ChatDeps): ChatHandle {
  let busy = false;

  async function playAndAnimate(audioContent: string, timepoints: { markName: string; timeSeconds: number }[], words: string[]) {
    if (!audioContent) throw new Error("TTS returned no audio");
    const audio = new Audio(`data:audio/mp3;base64,${audioContent}`);
    await new Promise<void>((resolve) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => resolve();
    });
    const dur = isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (timepoints.at(-1)?.timeSeconds ?? 1) + 0.4;
    const seq = visemesFromTimepoints(words, timepoints, dur);
    deps.onStatus("speaking…", "ok");
    await audio.play();         // playback has begun…
    deps.speak(seq);            // …start the mouth in sync (viseme times are audio-relative)
    await new Promise<void>((resolve) => { audio.onended = () => resolve(); });
  }

  async function send(text: string) {
    if (busy || !text.trim()) return;
    busy = true;
    try {
      deps.onStatus("thinking…");
      const chat = await postJson("/api/chat", { text: text.trim() });
      const reply = String(chat.reply ?? "");
      const emotion = String(chat.emotion ?? "neutral");
      deps.onReply(reply);
      deps.setExpression(emotion); // mood lands then auto-fades (driver)
      if (!reply) { deps.onStatus("(empty reply)", "err"); return; }

      deps.onStatus("voicing…");
      const tts = await postJson("/api/tts", { text: reply });
      await playAndAnimate(
        String(tts.audioContent ?? ""),
        (tts.timepoints as { markName: string; timeSeconds: number }[]) ?? [],
        (tts.words as string[]) ?? reply.split(/\s+/),
      );
      deps.onStatus("");
    } catch (e) {
      deps.onStatus((e as Error).message, "err");
    } finally {
      busy = false;
    }
  }

  // ---- mic: Web Speech API (free, in-browser) -----------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const micSupported = !!SR;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rec: any = null;
  let listening = false;

  function toggleMic() {
    if (!micSupported) { deps.onStatus("mic: this browser has no Web Speech API (try Chrome)", "err"); return; }
    if (listening) { rec?.stop(); return; }
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => { listening = true; deps.onMicState(true); deps.onStatus("listening…"); };
    rec.onerror = (e: { error?: string }) => { deps.onStatus(`mic: ${e.error ?? "error"}`, "err"); };
    rec.onend = () => { listening = false; deps.onMicState(false); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript ?? "";
      if (text) { deps.onTranscript(text); void send(text); }
    };
    rec.start();
  }

  return { send, toggleMic, micSupported };
}
