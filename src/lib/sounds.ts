"use client";

import type { Move } from "chess.js";

/**
 * Board sounds, synthesised in the browser with the Web Audio API.
 *
 * They are modelled on the chess.com set (a wooden "thock" for a move, a harder one for a capture, a double knock for
 * castling, a bright ping on check, a rising chime on promotion) but every sample is generated here: chess.com's audio
 * files are their own assets. Synthesis also means no network request and no decode delay, so the sound lands on the
 * same frame as the piece.
 *
 * Each sound is a short percussive layer ("thock": a noise transient through a bandpass, plus a body of damped
 * partials with a fast downward pitch glide) optionally followed by tonal blips.
 */

const STORAGE_KEY = "teachess:sound";
const MASTER_GAIN = 0.5;

/** Standalone sounds (the ones a played move does not produce). */
export type SoundKind = "gameStart" | "gameEnd" | "undo";

interface ThockSpec {
  /** Frequency of the body's first partial (Hz); the knock's pitch. */
  freq: number;
  /** Centre of the noise transient (Hz): higher is a sharper, harder click. */
  noiseFreq: number;
  noiseQ: number;
  /** Seconds for the noise transient and the body to fade out. */
  noiseDecay: number;
  bodyDecay: number;
  gain: number;
}

const MOVE_SELF: ThockSpec = { freq: 196, noiseFreq: 2600, noiseQ: 0.9, noiseDecay: 0.045, bodyDecay: 0.1, gain: 1 };
const MOVE_OPPONENT: ThockSpec = { freq: 165, noiseFreq: 2100, noiseQ: 0.9, noiseDecay: 0.05, bodyDecay: 0.11, gain: 0.95 };
const CAPTURE: ThockSpec = { freq: 132, noiseFreq: 1700, noiseQ: 0.6, noiseDecay: 0.1, bodyDecay: 0.16, gain: 1.25 };

// ---- audio graph (created on the first sound, i.e. after a user gesture) ----

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** White noise, cached per context: the raw material of every transient. */
function noiseBuffer(target: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(target);
  if (cached) return cached;
  const buffer = target.createBuffer(1, Math.ceil(target.sampleRate * 0.3), target.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(target, buffer);
  return buffer;
}

/** Ramps a gain from `peak` down to silence; `exponentialRamp` needs a non-zero target, hence the tiny floor. */
function envelope(target: BaseAudioContext, at: number, peak: number, decay: number, attack = 0.001): GainNode {
  const gain = target.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  gain.gain.setValueAtTime(0, at + attack + decay);
  return gain;
}

/** The knock of a piece landing on the board. */
function scheduleThock(target: BaseAudioContext, out: AudioNode, at: number, spec: ThockSpec) {
  // Transient: a filtered noise burst. This is what makes it read as wood rather than as a musical note.
  const noise = target.createBufferSource();
  noise.buffer = noiseBuffer(target);
  const band = target.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(spec.noiseFreq, at);
  band.frequency.exponentialRampToValueAtTime(spec.noiseFreq * 0.45, at + spec.noiseDecay);
  band.Q.value = spec.noiseQ;
  const noiseEnv = envelope(target, at, 0.5 * spec.gain, spec.noiseDecay);
  noise.connect(band).connect(noiseEnv).connect(out);
  noise.start(at);
  noise.stop(at + spec.noiseDecay + 0.05);

  // Body: two damped partials that drop in pitch as they decay, the way a struck solid does.
  for (const [ratio, level, decayScale] of [
    [1, 0.55, 1],
    [2.7, 0.16, 0.55],
  ] as const) {
    const osc = target.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(spec.freq * ratio * 1.35, at);
    osc.frequency.exponentialRampToValueAtTime(spec.freq * ratio, at + 0.03);
    const env = envelope(target, at, level * spec.gain, spec.bodyDecay * decayScale, 0.002);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + spec.bodyDecay * decayScale + 0.05);
  }
}

/** A short tonal blip (check ping, promotion chime, start/end notes). */
function scheduleBlip(target: BaseAudioContext, out: AudioNode, at: number, freq: number, gain: number, decay: number, type: OscillatorType = "triangle") {
  const osc = target.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  const env = envelope(target, at, gain, decay, 0.004);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.05);
}

/** What a move sounds like: the base knock plus the layers its flags call for. */
export interface MoveSoundSpec {
  base: "self" | "opponent" | "capture" | "castle";
  check: boolean;
  promotion: boolean;
}

export function moveSoundSpec(move: Move, self: boolean): MoveSoundSpec {
  const castle = move.flags.includes("k") || move.flags.includes("q");
  const capture = move.flags.includes("c") || move.flags.includes("e");
  return {
    base: castle ? "castle" : capture ? "capture" : self ? "self" : "opponent",
    check: move.san.includes("+") || move.san.includes("#"),
    promotion: !!move.promotion,
  };
}

function scheduleMove(target: BaseAudioContext, out: AudioNode, at: number, spec: MoveSoundSpec) {
  switch (spec.base) {
    case "capture":
      scheduleThock(target, out, at, CAPTURE);
      break;
    case "castle":
      // Rook then king: two knocks close enough to read as one gesture.
      scheduleThock(target, out, at, MOVE_SELF);
      scheduleThock(target, out, at + 0.085, { ...MOVE_OPPONENT, gain: 0.85 });
      break;
    case "opponent":
      scheduleThock(target, out, at, MOVE_OPPONENT);
      break;
    default:
      scheduleThock(target, out, at, MOVE_SELF);
  }
  if (spec.promotion) {
    // Rising arpeggio over the knock.
    scheduleBlip(target, out, at + 0.06, 784, 0.16, 0.18);
    scheduleBlip(target, out, at + 0.13, 1047, 0.16, 0.2);
    scheduleBlip(target, out, at + 0.2, 1319, 0.18, 0.3);
  }
  if (spec.check) {
    // Two quick bright notes: an alert that cuts through the knock without drowning it.
    scheduleBlip(target, out, at + 0.05, 1175, 0.14, 0.13);
    scheduleBlip(target, out, at + 0.115, 1568, 0.13, 0.2);
  }
}

function scheduleKind(target: BaseAudioContext, out: AudioNode, at: number, kind: SoundKind) {
  if (kind === "undo") {
    // A takeback is still a piece landing, just a softer one; the move it undoes must not be re-sounded (a captured
    // piece coming back is not a capture).
    scheduleThock(target, out, at, { ...MOVE_OPPONENT, gain: 0.75 });
    return;
  }
  // The chimes carry more gain than the knocks' bodies: a sine has no transient, so at equal peak it reads quieter.
  if (kind === "gameStart") {
    scheduleBlip(target, out, at, 523.25, 0.22, 0.22, "sine");
    scheduleBlip(target, out, at + 0.09, 783.99, 0.24, 0.35, "sine");
    return;
  }
  // gameEnd: a descending three-note figure.
  scheduleBlip(target, out, at, 659.25, 0.22, 0.24, "sine");
  scheduleBlip(target, out, at + 0.12, 523.25, 0.22, 0.26, "sine");
  scheduleBlip(target, out, at + 0.24, 392, 0.25, 0.5, "sine");
}

// ---- playback ----

function audio(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof window === "undefined") return null;
  if (!ctx || !master) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
  }
  // Browsers start the context suspended until a gesture; every sound here follows a click, drag or key press.
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return { ctx, master };
}

/** Plays the sound of `move`. `self` is true for the player at the board, false for the opponent's reply. */
export function playMoveSound(move: Move, self: boolean) {
  if (!soundOn) return;
  const a = audio();
  if (!a) return;
  scheduleMove(a.ctx, a.master, a.ctx.currentTime + 0.005, moveSoundSpec(move, self));
}

export function playSound(kind: SoundKind, delaySec = 0) {
  if (!soundOn) return;
  const a = audio();
  if (!a) return;
  scheduleKind(a.ctx, a.master, a.ctx.currentTime + 0.005 + delaySec, kind);
}

// ---- on/off, shared with React through a tiny store ----

let soundOn = true;
const listeners = new Set<() => void>();

export const subscribeSound = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const isSoundOn = () => soundOn;
/** The server (and the first client render) always assume sound is on; the stored preference is applied on mount. */
export const soundOnServer = () => true;

export function setSoundOn(on: boolean) {
  if (soundOn === on) return;
  soundOn = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode or storage disabled: the preference simply does not persist.
  }
  for (const l of listeners) l();
}

/** Applies the stored preference. Called from an effect so the first render matches the server's. */
export function loadSoundPreference() {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (stored === "off" && soundOn) {
    soundOn = false;
    for (const l of listeners) l();
  }
}

/** Development aid: plays every sound in turn (window.__teachess.playSounds()). */
export function demoSounds() {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime + 0.05;
  const specs: MoveSoundSpec[] = [
    { base: "self", check: false, promotion: false },
    { base: "opponent", check: false, promotion: false },
    { base: "capture", check: false, promotion: false },
    { base: "castle", check: false, promotion: false },
    { base: "self", check: true, promotion: false },
    { base: "self", check: false, promotion: true },
  ];
  specs.forEach((s, i) => scheduleMove(a.ctx, a.master, t + i * 0.6, s));
  scheduleKind(a.ctx, a.master, t + specs.length * 0.6, "undo");
  scheduleKind(a.ctx, a.master, t + specs.length * 0.6 + 0.6, "gameStart");
  scheduleKind(a.ctx, a.master, t + specs.length * 0.6 + 1.5, "gameEnd");
}

/** Renders one sound offline, for inspecting its waveform without a speaker. */
export async function renderSound(what: MoveSoundSpec | SoundKind, seconds = 1): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(1, Math.ceil(44100 * seconds), 44100);
  const gain = offline.createGain();
  gain.gain.value = MASTER_GAIN;
  gain.connect(offline.destination);
  if (typeof what === "string") scheduleKind(offline, gain, 0.01, what);
  else scheduleMove(offline, gain, 0.01, what);
  return offline.startRendering();
}
