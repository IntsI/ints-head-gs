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
// Lips do the SHAPING; jaw is kept subtle so it reads as articulation, not a hinge
// (only AA/OH really open the jaw). All channels are standard ARKit-52 morphs.
export const VISEMES: Record<string, Arkit> = {
  sil: {}, // rest / silence — mouth closes via the ease toward empty

  // --- consonant classes ---
  // p b m — lips fully meet, jaw closed
  PP: { mouthClose: 0.62, mouthPressLeft: 0.30, mouthPressRight: 0.30 },
  // f v — lower lip to upper teeth (lower lip down a touch). NO mouthRollLower — on
  // FLAME it everts the inner lip into a visible SECOND lip edge during speech.
  FF: { jawOpen: 0.05, mouthLowerDownLeft: 0.26, mouthLowerDownRight: 0.26 },
  // th — tongue tip between teeth, jaw mid (no shrug — it flares the nostrils)
  TH: { jawOpen: 0.15, tongueOut: 0.30 },
  // d t l n — alveolar; slight tongue, jaw mid
  DD: { jawOpen: 0.15, tongueOut: 0.12 },
  // k g — velar; small open, no lip shape
  KK: { jawOpen: 0.18, mouthLowerDownLeft: 0.08, mouthLowerDownRight: 0.08 },
  // ch j sh — rounded via PUCKER only. NO mouthFunnel — funnel + pucker together make
  // a doubled lip-ring (two lip edges) on FLAME during speech.
  CH: { jawOpen: 0.10, mouthPucker: 0.42 },
  // s z — narrow, slight spread; very small jaw (corners kept modest)
  SS: { jawOpen: 0.05, mouthStretchLeft: 0.18, mouthStretchRight: 0.18,
        mouthSmileLeft: 0.08, mouthSmileRight: 0.08, cheekSquintLeft: 0.04, cheekSquintRight: 0.04 },
  // n ng — nasal, lips close-ish
  NN: { jawOpen: 0.10, mouthClose: 0.24 },
  // r — rounded (pucker only; no funnel → no double lip-ring)
  RR: { jawOpen: 0.12, mouthPucker: 0.30 },

  // --- vowel shapes ---
  // ah — the one true jaw-opener; relaxed lips
  AA: { jawOpen: 0.45, mouthLowerDownLeft: 0.14, mouthLowerDownRight: 0.14 },
  // ee — wide but corners modest (stretch+smile pull the corners hard, so kept low)
  EE: { jawOpen: 0.08, mouthStretchLeft: 0.30, mouthStretchRight: 0.30,
        mouthSmileLeft: 0.14, mouthSmileRight: 0.14, cheekSquintLeft: 0.05, cheekSquintRight: 0.05 },
  // ih — wide-ish, a little more open than ee
  IH: { jawOpen: 0.16, mouthStretchLeft: 0.16, mouthStretchRight: 0.16,
        mouthSmileLeft: 0.08, mouthSmileRight: 0.08, cheekSquintLeft: 0.03, cheekSquintRight: 0.03 },
  // oh — rounded + open (jaw gives the openness, pucker the rounding; no funnel)
  OH: { jawOpen: 0.30, mouthPucker: 0.42 },
  // oo/uw — round, forward, small jaw (pucker only; no funnel → no double lip-ring)
  OU: { jawOpen: 0.08, mouthPucker: 0.66, cheekPuff: 0.04 },
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

/** One word → ordered viseme keys (no timing). Digraphs first, collapse repeats. */
export function wordToVisemeKeys(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const keys: string[] = [];
  let i = 0;
  let last = "";
  while (i < w.length) {
    const two = w.slice(i, i + 2);
    let v: string | undefined;
    if (DIGRAPHS[two]) { v = DIGRAPHS[two]; i += 2; }
    else { v = LETTERS[w[i]]; i += 1; }
    if (!v || v === "sil") continue;
    if (v === last) continue; // collapse repeats (e.g. "ll")
    last = v;
    keys.push(v);
  }
  return keys;
}

/** Stub: map text to an evenly-timed viseme sequence. Timing is FAKED. */
export function textToVisemes(text: string, opts: TextOpts = {}): VisemeSegment[] {
  const dur = opts.visemeDur ?? 0.09;
  const gap = opts.gapDur ?? 0.07;
  const segs: VisemeSegment[] = [];
  let t = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (const v of wordToVisemeKeys(word)) { segs.push({ viseme: v, startTime: t, duration: dur }); t += dur; }
    segs.push({ viseme: "sil", startTime: t, duration: gap }); t += gap; // brief close between words
  }
  return segs;
}

/**
 * REAL-timing path: build a viseme sequence from Google TTS SSML-mark timepoints.
 * Each word's viseme SHAPES come from wordToVisemeKeys(); the TIMING is anchored
 * to the actual audio — each word's visemes are spread across the measured
 * [wordStart, nextWordStart) window. So the mouth syncs to the real voice at word
 * granularity (sub-word visemes are evenly interpolated within each word).
 *
 * @param words       the words the SSML marks were inserted before (aligned to marks)
 * @param timepoints  [{markName:'w0', timeSeconds}] from TTS enableTimePointing
 * @param totalDur    audio duration (s) — closes the last word
 */
export function visemesFromTimepoints(
  words: string[],
  timepoints: { markName: string; timeSeconds: number }[],
  totalDur: number,
): VisemeSegment[] {
  const at = new Map(timepoints.map((tp) => [tp.markName, tp.timeSeconds]));
  const segs: VisemeSegment[] = [];
  for (let i = 0; i < words.length; i++) {
    const start = at.get(`w${i}`);
    if (start == null) continue;
    const end = at.get(`w${i + 1}`) ?? totalDur;
    const span = Math.max(end - start, 0.04);
    const keys = wordToVisemeKeys(words[i]);
    if (keys.length === 0) continue;
    const each = span / keys.length;
    keys.forEach((v, j) => segs.push({ viseme: v, startTime: start + j * each, duration: each }));
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

  const TAU_LIP = 0.05;  // lips ease fast (crisp consonants); short segs undershoot
  const TAU_JAW = 0.09;  // jaw is heavier/slower → reads semi-independent of the lips
  const TAIL = 0.18;     // keep easing toward sil this long after the last segment
  // anticipation: in the last (1-ANTIC_AT) of a segment, start blending toward the
  // NEXT viseme up to ANTIC_MAX — the mouth pre-forms the next sound (co-articulation).
  const ANTIC_AT = 0.6, ANTIC_MAX = 0.22;

  function lerpVis(a: Arkit, b: Arkit, t: number): Arkit {
    if (t <= 0) return a; if (t >= 1) return b;
    const out: Arkit = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t;
    return out;
  }

  function targetAt(t: number): Arkit {
    for (let i = 0; i < seq.length; i++) {
      const s = seq[i];
      if (t >= s.startTime && t < s.startTime + s.duration) {
        activeViseme = s.viseme;
        const cur = VISEMES[s.viseme] ?? {};
        const next = seq[i + 1] ? (VISEMES[seq[i + 1].viseme] ?? {}) : {};
        const p = (t - s.startTime) / Math.max(s.duration, 1e-4);
        const a = p > ANTIC_AT ? ANTIC_MAX * ((p - ANTIC_AT) / (1 - ANTIC_AT)) : 0;
        return a > 0 ? lerpVis(cur, next, a) : cur;
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

      // per-channel ease: jaw heavier (semi-independent), lips fast (crisp; fast
      // syllables naturally undershoot since cur can't reach the target in time).
      const kLip = 1 - Math.exp(-dt / TAU_LIP);
      const kJaw = 1 - Math.exp(-dt / TAU_JAW);
      for (const c of SPEECH_CHANNELS) {
        const k = c === "jawOpen" ? kJaw : kLip;
        cur[c] += ((target[c] ?? 0) - cur[c]) * k;
      }

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
