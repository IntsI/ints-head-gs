/**
 * Speech / mouth driver — stage 4 of the conversational head:
 *   user voice/text -> STT -> LLM persona -> TTS audio -> THIS -> head speaks.
 *
 * Renderer-agnostic (no DOM, no three.js): it just emits ARKit blendshape values
 * for the mouth each frame, to be composited as a BIAS over the living base
 * (breath/blink/saccades) and emotion expressions. Ports straight back to
 * ints-head (same getExpressionData pull model).
 *
 * THE FORWARD-LOOKING BIT: speak() accepts BOTH a raw timed viseme sequence (the
 * general form a TTS/phoneme source or LAM_Audio2Expression will supply) AND a
 * plain string (a stub text->viseme path for testing NOW). Both converge on the
 * same timed-viseme playback, so plugging in real timing later is a DATA swap,
 * not a code change.
 */

export type Arkit = Record<string, number>;

export interface VisemeSegment {
  viseme: string; // key into VISEMES
  startTime: number; // seconds from utterance start
  duration: number; // seconds
}

// ~16 visemes. Each = a target dict of jaw + lip + mouth + cheek ARKit coeffs.
// Principled mouth SHAPES (jawOpen always considered), not just lip width.
export const VISEMES: Record<string, Arkit> = {
  sil: {}, // rest / silence — mouth closes via the ease toward empty

  // --- consonant classes ---
  PP: { mouthClose: 0.35, mouthPressLeft: 0.25, mouthPressRight: 0.25 }, // p b m (lips together)
  FF: { jawOpen: 0.10, mouthRollLower: 0.45, mouthShrugUpper: 0.12 },    // f v (lip to teeth)
  TH: { jawOpen: 0.20, tongueOut: 0.30, mouthShrugUpper: 0.10 },         // th
  DD: { jawOpen: 0.22, mouthShrugUpper: 0.08 },                          // d t l n (alveolar)
  KK: { jawOpen: 0.26 },                                                 // k g (velar)
  CH: { jawOpen: 0.20, mouthFunnel: 0.50, mouthPucker: 0.28 },           // ch j sh (rounded)
  SS: { jawOpen: 0.12, mouthSmileLeft: 0.22, mouthSmileRight: 0.22,      // s z (narrow, spread)
        mouthStretchLeft: 0.18, mouthStretchRight: 0.18 },
  NN: { jawOpen: 0.14, mouthClose: 0.12 },                               // n ng
  RR: { jawOpen: 0.22, mouthFunnel: 0.30, mouthPucker: 0.18 },           // r

  // --- vowel shapes ---
  AA: { jawOpen: 0.55, mouthLowerDownLeft: 0.20, mouthLowerDownRight: 0.20 }, // ah (open)
  EE: { jawOpen: 0.18, mouthSmileLeft: 0.38, mouthSmileRight: 0.38,           // ee (wide)
        mouthStretchLeft: 0.28, mouthStretchRight: 0.28 },
  IH: { jawOpen: 0.26, mouthSmileLeft: 0.18, mouthSmileRight: 0.18 },         // ih
  OH: { jawOpen: 0.40, mouthFunnel: 0.42, mouthPucker: 0.22 },                // oh (rounded open)
  OU: { jawOpen: 0.18, mouthPucker: 0.60, mouthFunnel: 0.50 },                // oo/u (rounded tight)
};

/** Every channel any viseme can touch — so the ease can pull unused ones to 0. */
const SPEECH_CHANNELS: string[] = [...new Set(
  Object.values(VISEMES).flatMap((v) => Object.keys(v)),
)];

// ---- text -> viseme stub (FAKED even timing; replace with TTS marks later) ----
// Digraphs first, then single letters. Crude but enough to see articulation.
const DIGRAPHS: Record<string, string> = {
  th: "TH", ch: "CH", sh: "CH", ph: "FF", ck: "KK", ng: "NN",
  oo: "OU", ee: "EE", ou: "OU", ea: "EE", oa: "OH", ai: "EE",
};
const LETTERS: Record<string, string> = {
  a: "AA", e: "EE", i: "IH", o: "OH", u: "OU", y: "EE",
  p: "PP", b: "PP", m: "PP", f: "FF", v: "FF",
  d: "DD", t: "DD", l: "DD", n: "NN",
  k: "KK", g: "KK", c: "KK", q: "KK",
  j: "CH", s: "SS", z: "SS", x: "SS", r: "RR", w: "OU", h: "sil",
};

export interface TextOpts {
  visemeDur?: number; // seconds per viseme (default 0.09 ≈ natural-ish)
  gapDur?: number;    // silence between words (default 0.07)
}

/** Stub: map text to an evenly-timed viseme sequence. Timing is FAKED. */
export function textToVisemes(text: string, opts: TextOpts = {}): VisemeSegment[] {
  const dur = opts.visemeDur ?? 0.09;
  const gap = opts.gapDur ?? 0.07;
  const segs: VisemeSegment[] = [];
  let t = 0;
  const push = (viseme: string, d: number) => { segs.push({ viseme, startTime: t, duration: d }); t += d; };

  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    let i = 0;
    let last = "";
    while (i < word.length) {
      const two = word.slice(i, i + 2);
      let v: string | undefined;
      if (DIGRAPHS[two]) { v = DIGRAPHS[two]; i += 2; }
      else { v = LETTERS[word[i]]; i += 1; }
      if (!v || v === "sil") continue;
      if (v === last) continue; // collapse repeats (e.g. "ll")
      last = v;
      push(v, dur);
    }
    push("sil", gap); // brief close between words
  }
  return segs;
}

export interface SpeechHandle {
  /** Day-one dual input: a string (stub timing) OR a real timed viseme sequence. */
  speak: (input: string | VisemeSegment[], opts?: TextOpts) => void;
  stop: () => void;
  /** Advance playback. dt seconds. */
  update: (dt: number) => void;
  /** Current mouth ARKit deltas to composite over the living base. */
  getFrame: () => Arkit;
  isSpeaking: () => boolean;
  current: () => string; // active viseme key
}

export function createSpeech(): SpeechHandle {
  const cur: Arkit = {}; // eased current pose (only speech channels)
  for (const c of SPEECH_CHANNELS) cur[c] = 0;

  let seq: VisemeSegment[] = [];
  let clock = 0;       // internal seconds, advanced by update(dt)
  let startAt = 0;     // clock value when the utterance began
  let playing = false;
  let activeViseme = "sil";

  const TAU = 0.06;    // co-articulation ease: fast enough for speech, smooth (no snap)
  const TAIL = 0.18;   // keep easing toward sil this long after the last segment

  function targetAt(t: number): Arkit {
    // active segment = the one whose [start, start+dur) contains t (slight overlap
    // is provided by the ease itself). Past the end -> sil.
    for (const s of seq) {
      if (t >= s.startTime && t < s.startTime + s.duration) {
        activeViseme = s.viseme;
        return VISEMES[s.viseme] ?? {};
      }
    }
    activeViseme = "sil";
    return {};
  }

  return {
    speak(input, opts) {
      seq = typeof input === "string" ? textToVisemes(input, opts) : input.slice();
      startAt = clock;
      playing = seq.length > 0;
      if (!playing) activeViseme = "sil";
    },

    stop() { seq = []; playing = false; activeViseme = "sil"; },

    update(dt) {
      clock += dt;
      const t = clock - startAt;
      const target = playing ? targetAt(t) : {};

      const k = 1 - Math.exp(-dt / TAU);
      for (const c of SPEECH_CHANNELS) cur[c] += ((target[c] ?? 0) - cur[c]) * k;

      if (playing) {
        const end = seq.length ? seq[seq.length - 1].startTime + seq[seq.length - 1].duration : 0;
        if (t > end + TAIL) { playing = false; activeViseme = "sil"; }
      }
    },

    getFrame: () => cur,
    isSpeaking: () => playing,
    current: () => activeViseme,
  };
}
