"use client";

import type { ToolContext } from "./tools";
import { executeTool } from "./tools";
import type { LiveSessionOptions } from "./session-config";

export type TutorStatus = "off" | "connecting" | "live" | "closing" | "idle" | "error";

export interface TranscriptRow {
  id: number;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

export interface TutorState {
  status: TutorStatus;
  sessionId: string | null;
  transcript: TranscriptRow[];
  /** Seconds billed across all sessions of this lesson (live estimate). */
  usageSeconds: number;
  micLevel: number; // 0..1
  micAvailable: boolean;
  muted: boolean;
  speaking: boolean; // assistant currently producing speech (heuristic)
  thinking: boolean; // backend delegation in flight
  error: string | null;
  lastEvent: string | null;
  /** Last events received (type + short detail), newest last. For debugging. */
  eventLog: string[];
}

const EMPTY: TutorState = {
  status: "off",
  sessionId: null,
  transcript: [],
  usageSeconds: 0,
  micLevel: 0,
  micAvailable: false,
  muted: false,
  speaking: false,
  thinking: false,
  error: null,
  lastEvent: null,
  eventLog: [],
};

const MIC_THRESHOLD = 0.06; // RMS level considered "speech"
const MIC_WAKE_MS = 250; // sustained speech needed to wake an idle session
const ROW_GAP_MS = 1500; // transcript deltas further apart than this start a new row
const UTTERANCE_SETTLE_MS = 1800; // wall-clock silence after which a user transcript row is reported as an utterance
const STOP_MUTE_MS = 900; // output audio muted while a stop instruction takes effect
const COMMENTARY_FRESH_MS = 10_000; // commentary pushed within this window may still be unspoken

const STOP_INSTRUCTION =
  "Pare de falar imediatamente: o aluno já fez outro lance e o comentário anterior ficou desatualizado. " +
  "Não termine a frase nem retome o assunto. Fique em silêncio e ouça; o próximo comentário chegará em seguida.";

export interface LiveClientConfig {
  buildOptions: () => LiveSessionOptions;
  tools: ToolContext;
  idleTimeoutMs: number;
  /** Invoked when a brand-new (not forked) session starts, e.g. to greet. */
  onFreshSession?: () => void;
  /** Invoked once a student utterance (transcript row) has settled; `before` is the Professor's previous line. */
  onUserUtterance?: (text: string, before: string | null) => void;
}

/**
 * Owns the WebRTC connection to GPT-Live, the mic, the data channel and the
 * idle/wake lifecycle. Exposed to React through useSyncExternalStore.
 */
export class LiveTutorClient {
  private state: TutorState = EMPTY;
  private listeners = new Set<() => void>();
  private config: LiveClientConfig | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private micAboveSince: number | null = null;

  private idleTimer: number | null = null;
  private speakingTimer: number | null = null;
  private closeResolver: (() => void) | null = null;
  private enabled = false;
  private connectSeq = 0;
  private rowSeq = 0;
  private eventSeq = 0;
  private sessionUsageBase = 0; // usage of previous sessions in this lesson
  private pendingCalls: { call_id: string; name: string; arguments: string }[] = [];
  private pendingCallTimer: number | null = null;

  // ---- store plumbing ----
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY;
  private set(patch: Partial<TutorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  configure(config: LiveClientConfig) {
    this.config = config;
  }

  // ---- public API ----

  /** Start (or resume) the lesson: connects now and keeps auto-resuming until end(). */
  async start() {
    this.enabled = true;
    await this.ensureMic();
    await this.connect();
  }

  /** End the lesson: closes the session and stops auto-resume. Keeps the session id for a manual resume. */
  async end() {
    this.enabled = false;
    await this.closeSession("off");
  }

  /** Forget the stored session (new game): the next start() creates a fresh session. */
  resetConversation() {
    this.sessionUsageBase = this.state.usageSeconds;
    this.set({ sessionId: null, transcript: [] });
  }

  setMuted(muted: boolean) {
    if (this.micStream) for (const t of this.micStream.getAudioTracks()) t.enabled = !muted;
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
    this.set({ muted });
  }

  /** Call when something happened (a move) that should keep or wake the session. */
  noteActivity() {
    if (this.state.status === "live") this.resetIdle();
    else if (this.state.status === "idle" && this.enabled) void this.connect();
  }

  sendThinking(content: string) {
    return this.sendAppend("session.thinking.append", content);
  }
  sendCommentary(content: string) {
    const sent = this.sendAppend("session.commentary.append", content);
    if (sent) this.lastCommentaryAt = performance.now();
    return sent;
  }

  /**
   * Interrupts the Professor programmatically. The Live API has no cancel event, so this
   * follows OpenAI's documented pattern: send a corrective instruction and mute the output
   * on the client for a moment so already-queued audio is not heard. Returns true when an
   * interruption was attempted (the model was speaking or had fresh commentary to speak).
   */
  stop(): boolean {
    if (this.state.status !== "live") return false;
    const fresh = performance.now() - this.lastCommentaryAt < COMMENTARY_FRESH_MS;
    if (!this.state.speaking && !fresh) return false;
    this.lastCommentaryAt = 0;
    this.send({ type: "session.instructions.append", event_id: `stop_${++this.eventSeq}`, delegation_id: null, content: STOP_INSTRUCTION });
    if (this.audioEl) {
      this.audioEl.muted = true;
      if (this.unmuteTimer !== null) window.clearTimeout(this.unmuteTimer);
      this.unmuteTimer = window.setTimeout(() => {
        this.unmuteTimer = null;
        if (this.audioEl) this.audioEl.muted = false;
      }, STOP_MUTE_MS);
    }
    this.set({ speaking: false });
    return true;
  }
  sendInstructions(content: string) {
    return this.sendAppend("session.instructions.append", content);
  }

  dispose() {
    this.enabled = false;
    void this.closeSession("off");
    this.stopMic();
  }

  // ---- internals ----

  private pendingAppends: { type: string; content: string }[] = [];
  private lastCommentaryAt = 0;
  private unmuteTimer: number | null = null;
  private utteranceTimer: number | null = null;
  private lastUtterance: { id: number; text: string } | null = null;

  private sendAppend(type: string, content: string): boolean {
    if (this.state.status !== "live") {
      // Keep the most recent context for when the session (re)opens.
      if (this.enabled) this.pendingAppends = [...this.pendingAppends.slice(-5), { type, content }];
      return false;
    }
    this.send({ type, event_id: `evt_${++this.eventSeq}`, delegation_id: null, content });
    this.resetIdle();
    return true;
  }

  private send(event: Record<string, unknown>) {
    const stamp = new Date().toISOString().slice(11, 19);
    const ok = !!this.dc && this.dc.readyState === "open";
    this.set({ eventLog: [...this.state.eventLog.slice(-60), `${stamp} → ${String(event.type)}${ok ? "" : " (dropped: channel not open)"}`] });
    if (ok) this.dc!.send(JSON.stringify(event));
  }

  private async ensureMic() {
    if (this.micStream) return;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.micStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      const buf = new Float32Array(this.analyser.fftSize);
      this.levelTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms * 4);
        if (Math.abs(level - this.state.micLevel) > 0.01) this.set({ micLevel: level });
        this.onMicLevel(rms);
      }, 100);
      this.set({ micAvailable: true });
    } catch (e) {
      this.set({ micAvailable: false, error: `Microfone indisponível: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private silent: MediaStream | null = null;
  private silentStream(): MediaStream {
    if (this.silent) return this.silent;
    const ctx = this.audioCtx ?? new AudioContext();
    this.audioCtx = ctx;
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain).connect(dest);
    osc.start();
    this.silent = dest.stream;
    return this.silent;
  }

  private stopMic() {
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.analyser = null;
  }

  private onMicLevel(rms: number) {
    if (this.state.muted) return;
    const now = performance.now();
    if (rms >= MIC_THRESHOLD) {
      if (this.micAboveSince === null) this.micAboveSince = now;
      if (this.state.status === "live") this.resetIdle();
      else if (this.state.status === "idle" && this.enabled && now - this.micAboveSince >= MIC_WAKE_MS) {
        this.micAboveSince = null;
        void this.connect();
      }
    } else {
      this.micAboveSince = null;
    }
  }

  private resetIdle() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    const ms = this.config?.idleTimeoutMs ?? 90_000;
    this.idleTimer = window.setTimeout(() => {
      if (this.state.status === "live" && !this.state.thinking) void this.closeSession("idle");
      else this.resetIdle();
    }, ms);
  }

  private async connect() {
    if (!this.config) throw new Error("LiveTutorClient not configured");
    if (this.state.status === "connecting" || this.state.status === "live") return;
    const seq = ++this.connectSeq;
    this.set({ status: "connecting", error: null });

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      if (this.micStream) {
        for (const track of this.micStream.getAudioTracks()) pc.addTrack(track, this.micStream);
      } else {
        // No microphone: send a silent track so the session still has an inbound audio stream.
        const silent = this.silentStream();
        for (const track of silent.getAudioTracks()) pc.addTrack(track, silent);
      }

      if (!this.audioEl) {
        this.audioEl = document.createElement("audio");
        this.audioEl.autoplay = true;
      }
      pc.ontrack = (e) => {
        if (this.audioEl) {
          this.audioEl.srcObject = e.streams[0];
          void this.audioEl.play().catch(() => undefined);
        }
      };

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (e) => this.onEvent(String(e.data));
      dc.onclose = () => {
        if (this.connectSeq === seq && this.state.status === "live") this.teardown("idle", "connection_lost");
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 2000);

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local SDP");

      const forkId = this.state.sessionId;
      let res = forkId
        ? await fetch("/api/live/session/fork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: forkId, sdp }),
          })
        : null;
      let fresh = false;
      if (!res || !res.ok) {
        fresh = true;
        res = await fetch("/api/live/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp, options: this.config.buildOptions() }),
        });
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { session: { id: string }; transport: { sdp: string } };
      if (this.connectSeq !== seq) return; // superseded
      await pc.setRemoteDescription({ type: "answer", sdp: data.transport.sdp });
      this.set({ sessionId: data.session.id });
      this.freshPending = fresh;
    } catch (e) {
      this.teardown("error", e instanceof Error ? e.message : String(e));
    }
  }

  private freshPending = false;

  private onEvent(raw: string) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(ev.type);
    const detail =
      type === "error"
        ? JSON.stringify(ev.error)
        : type === "response.event"
          ? String((ev.event as { type?: string })?.type)
          : type.endsWith("transcript.delta")
            ? JSON.stringify(ev.delta)
            : "";
    const stamp = new Date().toISOString().slice(11, 19);
    this.set({ lastEvent: type, eventLog: [...this.state.eventLog.slice(-60), `${stamp} ${type} ${detail}`.trim()] });

    switch (type) {
      case "session.started": {
        this.set({ status: "live", error: null });
        this.resetIdle();
        if (this.state.muted) this.send({ type: "session.input_audio.mute" });
        if (this.freshPending) {
          this.freshPending = false;
          this.config?.onFreshSession?.();
        }
        const queued = this.pendingAppends;
        this.pendingAppends = [];
        for (const a of queued) this.sendAppend(a.type, a.content);
        return;
      }
      case "session.closed": {
        const usage = (ev.usage as { seconds?: number } | undefined)?.seconds ?? 0;
        this.set({ usageSeconds: this.sessionUsageBase + usage });
        this.sessionUsageBase = this.state.usageSeconds;
        this.closeResolver?.();
        this.closeResolver = null;
        return;
      }
      case "session.usage.updated": {
        const usage = (ev.usage as { seconds?: number } | undefined)?.seconds ?? 0;
        this.set({ usageSeconds: this.sessionUsageBase + usage });
        return;
      }
      case "session.input_transcript.delta":
        this.appendTranscript("user", ev);
        this.resetIdle();
        return;
      case "session.output_transcript.delta":
        this.appendTranscript("assistant", ev);
        this.markSpeaking();
        this.resetIdle();
        return;
      case "session.delegation.created":
        this.set({ thinking: true });
        this.resetIdle();
        return;
      case "response.event":
        this.onResponseEvent(ev.event as Record<string, unknown>);
        this.resetIdle();
        return;
      case "error": {
        const err = ev.error as { message?: string; code?: string } | undefined;
        this.set({ error: err?.message ?? "erro na sessão" });
        return;
      }
      default:
        return;
    }
  }

  private markSpeaking() {
    if (!this.state.speaking) this.set({ speaking: true });
    if (this.speakingTimer !== null) window.clearTimeout(this.speakingTimer);
    this.speakingTimer = window.setTimeout(() => this.set({ speaking: false }), 1200);
  }

  private appendTranscript(role: "user" | "assistant", ev: Record<string, unknown>) {
    const delta = String(ev.delta ?? "");
    const startMs = Number(ev.start_ms ?? 0);
    const endMs = Number(ev.end_ms ?? startMs);
    const rows = this.state.transcript;
    const last = rows[rows.length - 1];
    if (last && last.role === role && startMs - last.endMs <= ROW_GAP_MS) {
      const updated = { ...last, text: last.text + delta, endMs };
      this.set({ transcript: [...rows.slice(0, -1), updated] });
    } else {
      this.set({ transcript: [...rows, { id: ++this.rowSeq, role, text: delta, startMs, endMs }] });
    }
    if (role === "user") this.scheduleUtterance();
  }

  /** Reports the latest user row once no more fragments arrive for a moment (there is no turn-done event). */
  private scheduleUtterance() {
    if (this.utteranceTimer !== null) window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = window.setTimeout(() => {
      this.utteranceTimer = null;
      const rows = this.state.transcript;
      let idx = rows.length - 1;
      while (idx >= 0 && rows[idx].role !== "user") idx--;
      if (idx < 0) return;
      const row = rows[idx];
      const text = row.text.trim();
      if (!text || (this.lastUtterance?.id === row.id && this.lastUtterance.text === text)) return;
      this.lastUtterance = { id: row.id, text };
      let before: string | null = null;
      for (let j = idx - 1; j >= 0; j--) {
        if (rows[j].role === "assistant") {
          before = rows[j].text.trim();
          break;
        }
      }
      this.config?.onUserUtterance?.(text, before);
    }, UTTERANCE_SETTLE_MS);
  }

  private onResponseEvent(event: Record<string, unknown>) {
    const type = String(event.type);
    if (type === "response.output_item.done") {
      const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
      if (item?.type === "function_call" && item.call_id && item.name) {
        this.pendingCalls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? "" });
        // Fallback in case response.completed never arrives.
        if (this.pendingCallTimer !== null) window.clearTimeout(this.pendingCallTimer);
        this.pendingCallTimer = window.setTimeout(() => void this.runPendingCalls(), 2500);
      }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      if (this.pendingCalls.length > 0) void this.runPendingCalls();
      else this.set({ thinking: false });
    }
  }

  private async runPendingCalls() {
    if (this.pendingCallTimer !== null) window.clearTimeout(this.pendingCallTimer);
    this.pendingCallTimer = null;
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    if (calls.length === 0 || !this.config) return;
    for (const call of calls) {
      let output: string;
      try {
        output = await executeTool(call.name, call.arguments, this.config.tools);
      } catch (e) {
        output = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      this.send({
        type: "response.item.create",
        event_id: `tool_${++this.eventSeq}`,
        item: { type: "function_call_output", call_id: call.call_id, output },
      });
    }
    this.send({ type: "response.create", event_id: `continue_${++this.eventSeq}` });
  }

  private async closeSession(nextStatus: "idle" | "off") {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.pc || this.state.status === "off" || this.state.status === "idle") {
      if (this.state.status !== nextStatus && this.state.status !== "error") this.set({ status: nextStatus });
      return;
    }
    this.set({ status: "closing" });
    const closed = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
    this.send({ type: "session.close" });
    await Promise.race([closed, new Promise<void>((r) => window.setTimeout(r, 3000))]);
    this.teardown(nextStatus, null);
  }

  private teardown(status: TutorStatus, error: string | null) {
    this.connectSeq++;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    if (this.unmuteTimer !== null) window.clearTimeout(this.unmuteTimer);
    this.unmuteTimer = null;
    if (this.utteranceTimer !== null) window.clearTimeout(this.utteranceTimer);
    this.utteranceTimer = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.muted = false;
    }
    this.lastCommentaryAt = 0;
    this.pendingCalls = [];
    this.closeResolver = null;
    this.set({ status, thinking: false, speaking: false, error: error ?? (status === "error" ? this.state.error : null) });
  }
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}
