"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { Board } from "@/components/Board";
import { CoachPanel, type BoardPreview } from "@/components/CoachPanel";
import { EnginePanel, type UciMove } from "@/components/EnginePanel";
import { EvalBar } from "@/components/EvalBar";
import { GameStatus } from "@/components/GameStatus";
import { LessonSetup, type LessonSettings } from "@/components/LessonSetup";
import { MoveList } from "@/components/MoveList";
import { EnginePlayer, STRENGTH_PRESETS } from "@/lib/engine-player";
import { applyLine, MoveTableEngine } from "@/lib/move-table";
import { formatScoreWhite, parseUci, pvToSan, summarizeLines } from "@/lib/engine-format";
import { buildCommentRequest, fetchComment, greetingInstruction, statusText, verificationTrace, warmCommentWriter, type MoveContext } from "@/lib/live/lesson";
import { DEFAULT_VOICE } from "@/lib/live/session-config";
import type { ToolContext } from "@/lib/live/tools";
import { notesThinking, updateLessonNotes } from "@/lib/live/notes";
import { stopUndoInstruction } from "@/lib/live/live-client";
import { useLang } from "@/lib/i18n/LangProvider";
import { UI } from "@/lib/i18n/ui";
import { useLiveTutor } from "@/lib/live/useLiveTutor";
import { statusForFen, useChessGame } from "@/lib/useChessGame";
import { demoSounds, isSoundOn, loadSoundPreference, playMoveSound, playSound, renderSound, setSoundOn, soundOnServer, subscribeSound } from "@/lib/sounds";
import { useEngine, type AnalysisSnapshot } from "@/lib/useEngine";
import { buildRecords, materialSummary, positionEvalFromSnapshot, recordToJson, worstMoves } from "@/lib/game-record";
import type { Arrow, CoachSquare } from "@/lib/chess-utils";
import { planFromProse } from "@/lib/mentions/grammar";
import type { MatchEvent } from "@/lib/mentions/matcher";
import { kingSquare, planFromParts } from "@/lib/mentions/resolve";
import type { Mention } from "@/lib/mentions/types";
import { illegalLineReport, impossibleClaims, legalMovesByPiece } from "@/lib/mentions/validate";

const COST_PER_MINUTE = 0.05;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MENTION_LIFETIME_MS = 4000; // highlights stay this long after the last mention (and after the Professor stops talking)
const MENTION_FADE_MS = 700; // must match the CSS transition on the coach layer
// Turn pipeline (student move → Professor reply → one spoken comment). Every wait here is on the path to speech.
const STUDENT_ANALYSIS_WAIT_MS = 1500; // max wait for depth 12 on the student's move before replying (its classification)
const COMMENT_MIN_DEPTH = 10; // depth of the new position handed to the comment writer (enough for a 50-word comment)
const COMMENT_ANALYSIS_WAIT_MS = 700;

// When the Professor's decided reply goes on the board. The move waits for him to say it; these are the fallbacks
// that guarantee it lands anyway. Silence is the one that normally matters: a blind cap measured from the first
// sound lands the move mid-sentence, because a correction ("that was a mistake, better was...") can run for eight
// seconds before he ever names his own move.
const REPLY_SILENT_MS = 800; // no voice to wait for (session not live): a plain, natural pause
const REPLY_WATCHDOG_MS = 8000; // from the decision, in case the comment writer never comes back
const REPLY_NO_SPEECH_MS = 2500; // comment handed over, but he never started speaking
const REPLY_SPEAKING_GRACE_MS = 4000; // while he is audible the deadline keeps moving: he is still getting there
const REPLY_QUIET_MS = 1200; // he went quiet without ever naming the move (plus the ~600 ms the analyser needs)
const REPLY_HARD_CAP_MS = 25_000; // absolute floor under everything, however the speech detection behaves

type PlayedMove = { move: Move; fenBefore: string; ply: number };

/**
 * The Professor's reply, chosen but not yet on the board. It lands the moment he says it ("I play pawn to d5"),
 * which the speech matcher reports; the fields below drive the fallbacks for when he never quite says it.
 */
interface PendingReply {
  move: PlayedMove;
  /** Land no later than this; pushed further out for as long as he is audible. */
  deadline: number;
  /** Never held past this, whatever the speech detection says. */
  hardDeadline: number;
  /** True once the comment is with him: from then on his voice decides when the move lands. */
  watchSpeech: boolean;
  /** True once he has actually been heard since the comment was handed over. */
  spoke: boolean;
  quietSince: number | null;
}

const ARROW_COLOR = {
  focus: { move: "coach", capture: "capture", check: "check" },
  dim: { move: "coachDim", capture: "captureDim", check: "checkDim" },
} as const;

/** Board overlays for a set of mentions: the ones in focus drawn bright, the earlier ones dimmed. */
function visualsOf(focus: Mention[], dim: Mention[]): { squares: CoachSquare[]; arrows: Arrow[] } {
  const squares = new Map<Square, CoachSquare>();
  const arrows: Arrow[] = [];
  for (const m of dim) {
    for (const sq of m.visual.squares) squares.set(sq, { square: sq, level: "dim" });
    for (const a of m.visual.arrows) arrows.push({ from: a.from, to: a.to, color: ARROW_COLOR.dim[a.kind] });
  }
  for (const m of focus) {
    for (const sq of m.visual.squares) squares.set(sq, { square: sq, level: "focus" });
    for (const a of m.visual.arrows) arrows.push({ from: a.from, to: a.to, color: ARROW_COLOR.focus[a.kind] });
  }
  return { squares: [...squares.values()], arrows };
}

export default function Home() {
  const lang = useLang();
  const t = UI[lang].page;
  const game = useChessGame();
  const [flipped, setFlipped] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [hoveredEngineMove, setHoveredEngineMove] = useState<UciMove | null>(null);

  const engine = useEngine(game.fen, { enabled: !game.status.over, multiPv: 3, maxDepth: 20 });

  // Annotated game record: evals before/after each move, classification, best alternative.
  const records = useMemo(() => buildRecords(game.history, engine.analyses), [game.history, engine.analyses]);
  const currentEval = useMemo(() => {
    const fromEngine = positionEvalFromSnapshot(engine.analyses.get(game.fen));
    if (fromEngine) return fromEngine;
    const last = records[records.length - 1];
    return last && last.fenAfter === game.fen ? last.after : null;
  }, [engine.analyses, game.fen, records]);

  // ----- lesson state -----
  const [settings, setSettings] = useState<LessonSettings>(() => ({
    userColor: "w",
    strength: "intermediate",
    voice: DEFAULT_VOICE[lang],
    idleTimeoutSec: 90,
    showEngine: false,
  }));
  const [lessonActive, setLessonActive] = useState(false);
  /** The Professor's reply while it waits to be announced. */
  const pendingReply = useRef<PendingReply | null>(null);
  const replyWatcher = useRef<number | null>(null);
  /** Position the board will be in once the pending reply lands; drives the engine memory ahead of time. */
  const [pendingFen, setPendingFen] = useState<string | null>(null);
  const soundOn = useSyncExternalStore(subscribeSound, isSoundOn, soundOnServer);
  useEffect(() => loadSoundPreference(), []); // after mount, so the first render matches the server's
  const [coachArrows, setCoachArrows] = useState<Arrow[]>([]);
  const [coachSquares, setCoachSquares] = useState<Square[]>([]);
  /** What the Professor is talking about right now (last item is the current focus). */
  const [liveMentions, setLiveMentions] = useState<Mention[]>([]);
  const [liveFading, setLiveFading] = useState(false);
  const liveTimer = useRef<number | null>(null);
  /** Board snapshot shown while hovering the transcript. */
  const [preview, setPreview] = useState<BoardPreview | null>(null);
  const [player] = useState(() => new EnginePlayer());
  useEffect(() => () => player.dispose(), [player]);
  // Engine memory: every legal move of the position the student is looking at, pre-evaluated.
  const [moveTable] = useState(() => new MoveTableEngine());
  useEffect(() => () => moveTable.dispose(), [moveTable]);
  useEffect(() => {
    // While a reply waits to be announced it is the Professor's turn on the board but the student's turn in the
    // position that matters, so the tables are built for that one: they are ready the instant the move lands.
    const studentToMove = !lessonActive || game.turn === settings.userColor;
    const fen = pendingFen ?? (studentToMove ? game.fen : null);
    moveTable.setPosition(!game.status.over && fen ? fen : null);
  }, [moveTable, game.fen, game.turn, game.status.over, lessonActive, settings.userColor, pendingFen]);

  // Latest values readable from async callbacks.
  const gameRef = useRef(game);
  const langRef = useRef(lang);
  const engineRef = useRef(engine);
  const settingsRef = useRef(settings);
  const lessonRef = useRef(lessonActive);
  /** Application memory about the student (name, chosen opening, plans). Kept across games in this sitting. */
  const notesRef = useRef("");
  useEffect(() => {
    gameRef.current = game;
    engineRef.current = engine;
    settingsRef.current = settings;
    lessonRef.current = lessonActive;
    langRef.current = lang;
  });

  /** Waits until the analysis for `fen` reaches `minDepth` (or times out) and returns it. */
  const waitForAnalysis = useCallback(async (fen: string, minDepth: number, timeoutMs: number) => {
    const started = performance.now();
    for (;;) {
      const snap = engineRef.current.analyses.get(fen);
      if (snap && snap.depth >= minDepth) return snap;
      if (performance.now() - started > timeoutMs) return snap;
      await delay(100);
    }
  }, []);

  /** Records built from the latest game + analysis (for async callbacks). */
  const latestRecords = useCallback(() => buildRecords(gameRef.current.history, engineRef.current.analyses), []);

  // ----- tools the tutor's backend can call (run in the browser) -----
  const tools = useMemo<ToolContext>(
    () => ({
      getPosition: () => {
        const g = gameRef.current;
        const recs = latestRecords();
        const userColor = settingsRef.current.userColor;
        const L = langRef.current;
        const material = materialSummary(g.fen, L);
        const evaluation = positionEvalFromSnapshot(engineRef.current.analyses.get(g.fen));
        const lastStudent = [...recs].reverse().find((r) => r.color === userColor);
        // Once a reply is announced, the student is really being asked about the position it creates.
        const askedFen = pendingReply.current?.move.move.after ?? g.fen;
        return {
          fen: g.fen,
          turn: g.turn,
          userColor,
          status: statusText(g.status, L),
          evaluation: evaluation?.text ?? null,
          material: material.text,
          materialBalance: material.balance,
          pieces: material.pieces,
          pieceTypesNeedingSquare: material.duplicated,
          recentMoves: recs.slice(-8).map((r) => recordToJson(r, L)),
          lastMove: recs.length ? recordToJson(recs[recs.length - 1], L) : null,
          lastStudentMove: lastStudent ? recordToJson(lastStudent, L) : null,
          candidateMoves: (moveTable.get(askedFen)?.moves ?? []).slice(0, 40).map((m) => ({
            move: m.san,
            eval: m.eval,
            bestReply: m.bestReply,
            line: m.line.slice(0, 4),
          })),
          candidateDepth: moveTable.get(askedFen)?.depth ?? 0,
          // The complete legal move list grouped by piece: "can my queen take on c4?" is a lookup, not a guess.
          legalMovesByPiece: legalMovesByPiece(askedFen),
          pendingTutorMove: pendingReply.current?.move.move.san ?? null,
          lessonNotes: notesRef.current || (L === "pt-BR" ? "(nenhuma ainda)" : "(none yet)"),
          studentSaid: tutorClientRef.current
            .getSnapshot()
            .transcript.filter((r) => r.role === "user")
            .slice(-5)
            .map((r) => r.text),
        };
      },
      getGameHistory: () => {
        const recs = latestRecords();
        const userColor = settingsRef.current.userColor;
        return {
          moves: recs.map((r) => recordToJson(r, langRef.current)),
          worstStudentMoves: worstMoves(recs, userColor, langRef.current),
          worstTutorMoves: worstMoves(recs, userColor === "w" ? "b" : "w", langRef.current),
          material: materialSummary(gameRef.current.fen, langRef.current).text,
        };
      },
      getEngineLines: async (minDepth) => {
        const fen = gameRef.current.fen;
        const snap = await waitForAnalysis(fen, minDepth, 3000);
        if (!snap) return { depth: 0, lines: [] };
        return { depth: snap.depth, lines: summarizeLines(fen, snap.lines, 6) };
      },
      evaluateLine: async (moves) => {
        const fen = gameRef.current.fen;
        const applied = applyLine(fen, moves);
        if (!applied) return { legal: false, moves, ...illegalLineReport(fen, moves, langRef.current) };
        // A single move is already in the engine memory when the table is deep enough.
        if (applied.san.length === 1) {
          const table = await moveTable.waitFor(fen, 10, 1500);
          const hit = table?.moves.find((m) => m.san === applied.san[0]);
          if (hit && table && table.depth >= 10) {
            return { legal: true, moves: applied.san, evalAfter: hit.eval, bestReply: hit.bestReply, line: hit.line, depth: table.depth, source: "memory" };
          }
        }
        const res = await player.search(applied.fen, { depth: 12 });
        const turnAfter = applied.fen.split(" ")[1] as Color;
        const evalAfter = res.score ? formatScoreWhite(res.score, turnAfter).text : null;
        const reply = res.bestmove !== "(none)" ? pvToSan(applied.fen, [res.bestmove], 1)[0] ?? null : null;
        const line = pvToSan(applied.fen, res.pv, 5);
        return { legal: true, moves: applied.san, evalAfter, bestReply: reply, line, depth: res.depth, source: "search" };
      },
      setCoachAnnotations: ({ arrows, squares, clear }) => {
        if (clear) {
          setCoachArrows([]);
          setCoachSquares([]);
          return;
        }
        if (arrows) setCoachArrows(arrows.map((a) => ({ from: a.from as Square, to: a.to as Square, color: "coach" })));
        if (squares) setCoachSquares(squares as Square[]);
      },
    }),
    [player, moveTable, waitForAnalysis, latestRecords],
  );
  // Dev hook: lets the tools and the engine memory be inspected from the browser console.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    (window as unknown as { __teachess?: unknown }).__teachess = {
      tools,
      moveTable,
      client: tutorClientRef.current,
      /** Shows the coach panel without opening a paid session (to try debugSpeak). */
      offlineLesson: () => setLessonActive(true),
      /** Plays every board sound in turn. */
      playSounds: demoSounds,
      /** Renders one sound offline, to inspect it without a speaker. */
      renderSound,
    };
  }, [tools, moveTable]);

  const tutor = useLiveTutor({
    lang: () => langRef.current,
    tools,
    idleTimeoutMs: settings.idleTimeoutSec * 1000,
    buildOptions: () => {
      const g = gameRef.current;
      const s = settingsRef.current;
      const preset = STRENGTH_PRESETS.find((p) => p.id === s.strength)!;
      const L = langRef.current;
      const moves = g.history.map((m) => m.san).join(" ");
      const initialContext =
        L === "pt-BR"
          ? `Configuração da aula: o aluno joga de ${s.userColor === "w" ? "brancas" : "pretas"}; ` +
            `nível do Professor: ${preset.label[L]}. Lances até agora: ${moves || "(nenhum)"}. ` +
            `Situação: ${statusText(g.status, L)}.` +
            (notesRef.current ? ` Notas da aula: ${notesRef.current}` : "")
          : `Lesson setup: the student plays ${s.userColor === "w" ? "White" : "Black"}; ` +
            `Professor level: ${preset.label[L]}. Moves so far: ${moves || "(none)"}. ` +
            `Status: ${statusText(g.status, L)}.` +
            (notesRef.current ? ` Lesson notes: ${notesRef.current}` : "");
      return { voice: s.voice, userColor: s.userColor, lang: L, initialContext };
    },
    onFreshSession: () => {
      tutor.client.sendInstructions(greetingInstruction(settingsRef.current.userColor, langRef.current));
    },
    onUserUtterance: (text, before) => {
      void (async () => {
        const notes = await updateLessonNotes({ lang: langRef.current, notes: notesRef.current, utterance: text, professorBefore: before });
        if (notes === null || notes === notesRef.current) return;
        notesRef.current = notes;
        tutor.client.sendThinking(notesThinking(notes, langRef.current));
      })();
    },
    getFen: () => gameRef.current.fen,
    userColor: () => settingsRef.current.userColor,
    recentSquares: () => gameRef.current.history.slice(-2).reverse().map((m) => m.to),
    recentFens: () => gameRef.current.history.slice(-4).reverse().map((m) => m.before),
    onMention: (e: MatchEvent) => {
      if (e.role !== "assistant") return;
      // "I play pawn to d5": the move goes on the board on the word, before the highlight is drawn.
      if (isAnnouncement(e.mention)) landReply("announced");
      showMention(e.mention, e.replacesId);
    },
    onBackendText: (text) => {
      const g = gameRef.current;
      const recentFens = g.history.slice(-4).reverse().map((m) => m.before);
      const plan = planFromProse(`b${Date.now()}`, text, g.fen, {
        lang: langRef.current,
        speaker: "professor",
        userColor: settingsRef.current.userColor,
        recentSquares: g.history.slice(-2).reverse().map((m) => m.to),
        recentFens,
      });
      if (plan.steps.length) tutor.client.setPlan(plan);
      // The backend's answer cannot be gated before the voice model speaks it (Responses delegation), but a claim
      // about a move that exists in no position of the game so far is worth a loud line in the events panel.
      const pendingFen = pendingReply.current?.move.move.after;
      const impossible = impossibleClaims(text, [g.fen, ...(pendingFen ? [pendingFen] : []), ...recentFens], settingsRef.current.userColor, langRef.current);
      if (impossible.length) tutor.client.trace(`⚠ backend described a move or piece that does not exist: ${impossible.map((t) => `"${t}"`).join(", ")}`);
    },
  });
  const tutorClient = tutor.client;
  const tutorClientRef = useRef(tutorClient);
  tutorClientRef.current = tutorClient;
  /** Push-to-talk (Space / talk button). Stable identity: the panel binds it once per lesson. */
  const talk = useCallback((on: boolean) => tutorClient.setTalking(on), [tutorClient]);

  // ----- the Professor's reply lands when he announces it -----
  const clearReplyWatcher = useCallback(() => {
    if (replyWatcher.current !== null) window.clearInterval(replyWatcher.current);
    replyWatcher.current = null;
  }, []);

  /** Drops a decided reply without playing it (takeback, new game, lesson over). */
  const cancelReply = useCallback(() => {
    pendingReply.current = null;
    setPendingFen(null);
    clearReplyWatcher();
  }, [clearReplyWatcher]);

  /** Puts the decided reply on the board. Called when he says it, and by every fallback. */
  const landReply = useCallback(
    (reason: string) => {
      const pending = pendingReply.current;
      if (!pending) return;
      const g = gameRef.current;
      cancelReply();
      if (g.fen !== pending.move.fenBefore) return; // a takeback or a new game got there first
      const m = pending.move.move;
      const mv = g.makeMove(m.from as Square, m.to as Square, m.promotion as PieceSymbol | undefined);
      if (!mv) return;
      playMoveSound(mv, false);
      if (new Chess(mv.after).isGameOver()) playSound("gameEnd", 0.35);
      tutorClient.trace(`Professor played ${mv.san} (${reason})`);
    },
    [cancelReply, tutorClient],
  );

  /**
   * Watches for the moment to land the move: while he is quiet it is a plain deadline, and once the comment is with
   * him his voice takes over (land when he stops talking, or at the cap measured from the first sound).
   */
  const startReplyWatcher = useCallback(() => {
    clearReplyWatcher();
    replyWatcher.current = window.setInterval(() => {
      const pending = pendingReply.current;
      if (!pending) {
        clearReplyWatcher();
        return;
      }
      const now = performance.now();
      if (now >= pending.hardDeadline) {
        landReply("hard limit");
        return;
      }
      if (pending.watchSpeech) {
        if (tutorClientRef.current.getSnapshot().speaking) {
          // Still talking: he may yet be working his way to the announcement, so keep the deadline ahead of him.
          pending.spoke = true;
          pending.quietSince = null;
          pending.deadline = now + REPLY_SPEAKING_GRACE_MS;
        } else if (pending.spoke) {
          if (pending.quietSince === null) pending.quietSince = now;
          else if (now - pending.quietSince >= REPLY_QUIET_MS) {
            landReply("finished without naming the move");
            return;
          }
          return;
        }
      }
      if (now >= pending.deadline) landReply(pending.spoke ? "announcement not recognised" : "no speech");
    }, 150);
  }, [clearReplyWatcher, landReply]);

  /** Holds a freshly decided reply back until it is announced (or until a fallback fires). */
  const armReply = useCallback(
    (move: PlayedMove) => {
      const live = tutorClientRef.current.getSnapshot().status === "live";
      pendingReply.current = {
        move,
        // With no live session there is no announcement coming: just pause long enough to be read as a move.
        deadline: performance.now() + (live ? REPLY_WATCHDOG_MS : REPLY_SILENT_MS),
        // Off the voice path the plain deadline should be the one that fires, so the log says why.
        hardDeadline: performance.now() + (live ? REPLY_HARD_CAP_MS : REPLY_SILENT_MS + 2000),
        watchSpeech: false,
        spoke: false,
        quietSince: null,
      };
      setPendingFen(move.move.after);
      startReplyWatcher();
    },
    [startReplyWatcher],
  );

  /** The comment is with the Professor: from here his voice decides when the move lands. */
  const awaitAnnouncement = useCallback((move: PlayedMove) => {
    const pending = pendingReply.current;
    if (!pending || pending.move !== move) return;
    pending.watchSpeech = true;
    pending.spoke = false;
    pending.quietSince = null;
    pending.deadline = performance.now() + REPLY_NO_SPEECH_MS;
  }, []);

  /** True when this mention is the Professor naming the reply he is holding. */
  const isAnnouncement = useCallback((mention: Mention) => {
    const pending = pendingReply.current;
    if (!pending || mention.body.kind !== "move") return false;
    return mention.body.color !== settingsRef.current.userColor && mention.body.san === pending.move.move.san;
  }, []);

  useEffect(() => () => clearReplyWatcher(), [clearReplyWatcher]);

  // ----- live highlights (what the Professor is saying right now) -----
  const clearLive = useCallback(() => {
    if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
    liveTimer.current = null;
    setLiveFading(false);
    setLiveMentions([]);
  }, []);

  /** Arms the lifetime: highlights fade a few seconds after the last mention, once the Professor is quiet. */
  const armLiveTimer = useCallback(
    (ms: number) => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
      liveTimer.current = window.setTimeout(() => {
        liveTimer.current = null;
        if (tutorClientRef.current.getSnapshot().speaking) {
          armLiveTimer(1500);
          return;
        }
        setLiveFading(true);
        liveTimer.current = window.setTimeout(() => {
          liveTimer.current = null;
          setLiveFading(false);
          setLiveMentions([]);
        }, MENTION_FADE_MS);
      }, ms);
    },
    [],
  );

  function showMention(m: Mention, replacesId: string | null = null) {
    setLiveFading(false);
    setLiveMentions((prev) => [...prev.filter((o) => o.id !== m.id && o.id !== replacesId), m].slice(-6));
    armLiveTimer(MENTION_LIFETIME_MS);
  }
  useEffect(() => () => clearLive(), [clearLive]);

  // ----- per-turn commentary -----
  /** The student's move awaiting the Professor's reply, so one comment covers the whole turn. */
  const pendingStudent = useRef<PlayedMove | null>(null);
  /** What the Professor already said about earlier turns (so the writer does not repeat itself). */
  const previousComments = useRef<string[]>([]);

  /**
   * Evaluates a position the board is not on. The background engine only ever analyses the current position, so the
   * position the Professor's held reply would create has to be searched on purpose, with the opponent's worker.
   */
  const analyseAside = useCallback(
    async (fen: string, depth: number): Promise<AnalysisSnapshot | undefined> => {
      const known = engineRef.current.analyses.get(fen);
      if (known && known.depth >= depth) return known;
      const res = await player.search(fen, { depth });
      if (!res.score || res.pv.length === 0) return known;
      return { fen, depth: res.depth, lines: [{ multipv: 1, depth: res.depth, score: res.score, pv: res.pv }] };
    },
    [player],
  );

  const moveContext = useCallback(
    async (m: PlayedMove, minDepth: number, waitMs: number, aside = false): Promise<MoveContext> => {
      const before = engineRef.current.analyses.get(m.fenBefore);
      const after = aside ? await analyseAside(m.move.after, minDepth) : await waitForAnalysis(m.move.after, minDepth, waitMs);
      // A held reply is not in the history yet, so it has no record: the writer only needs the student's grade anyway.
      const record = latestRecords().find((r) => r.ply === m.ply && r.san === m.move.san);
      return { move: m.move, fenBefore: m.fenBefore, before, after, record, ply: m.ply };
    },
    [waitForAnalysis, latestRecords, analyseAside],
  );

  /**
   * One spoken comment for the turn: the only thing the Professor says about the moves. (There used to be a silent
   * `session.thinking.append` per move as well, but the live model read it aloud, so every turn was narrated twice.)
   * Dropped if the board has moved on by the time it is ready.
   */
  const commentOnTurn = useCallback(
    async (student: PlayedMove | null, reply: PlayedMove | null) => {
      const target = reply ?? student;
      if (!target) return;
      // The reply is decided but held off the board, so what must stay put is the position the student left.
      const boardFen = reply ? reply.fenBefore : target.move.after;
      const t0 = performance.now();
      // The engine follows the board, so the student's position is no longer being analysed: its snapshot is whatever
      // depth it reached while the reply was chosen, and waiting would only add time. The position the reply creates
      // is not on the board at all, so it is searched aside.
      const [studentCtx, tutorCtx] = await Promise.all([
        student ? moveContext(student, 12, 0) : null,
        reply ? moveContext(reply, COMMENT_MIN_DEPTH, COMMENT_ANALYSIS_WAIT_MS, true) : null,
      ]);
      const g = gameRef.current;
      if (g.fen !== boardFen) return; // a takeback or a new game got there first
      // Everything the writer sees describes the position the reply will create, not the one on the board: it is
      // announcing its own move, so the material, the status and the move list must already include it.
      const history = reply ? [...g.history, reply.move] : g.history;
      const fenNow = reply ? reply.move.after : g.fen;
      const analyses = new Map(engineRef.current.analyses);
      if (tutorCtx?.after) analyses.set(tutorCtx.after.fen, tutorCtx.after);
      const req = buildCommentRequest({
        lang: langRef.current,
        userColor: settingsRef.current.userColor,
        studentMove: studentCtx,
        tutorMove: tutorCtx,
        history,
        fenNow,
        status: reply ? statusForFen(fenNow) : g.status,
        records: buildRecords(history, analyses),
        lessonNotes: notesRef.current,
        conversation: tutorClient
          .getSnapshot()
          .transcript.slice(-8)
          .map((r) => ({ role: r.role === "user" ? "student" : "professor", text: r.text })),
        previousComments: previousComments.current.slice(-3),
      });
      const tWriter = performance.now();
      tutorClient.trace(
        `turn: context ready in ${Math.round(tWriter - t0)}ms (student depth ${studentCtx?.after?.depth ?? "-"}, Professor depth ${tutorCtx?.after?.depth ?? "-"}), requesting comment`,
      );
      const result = await fetchComment(req);
      // On every path out from here the reply is left to the watchdog, which plays it a moment later.
      if (!result) {
        tutorClient.trace(`turn: no comment (writer failed in ${Math.round(performance.now() - tWriter)}ms)`);
        return;
      }
      const how = verificationTrace(result.verification);
      tutorClient.trace(`turn: comment written in ${Math.round(performance.now() - tWriter)}ms${how ? `, ${how}` : ""}`);
      if (gameRef.current.fen !== boardFen) return; // moved on while the writer worked
      const plan = planFromParts(`c${target.ply}`, fenNow, result.parts, "comment");
      const sent = await tutorClient.sendCommentary(result.comment, () => gameRef.current.fen === boardFen);
      if (!sent) return;
      if (plan.steps.length) tutorClient.setPlan(plan);
      if (reply) awaitAnnouncement(reply);
      previousComments.current = [...previousComments.current.slice(-5), result.comment];
    },
    [moveContext, tutorClient, awaitAnnouncement],
  );

  // ----- moves -----
  const handleMove = useCallback(
    (from: Square, to: Square, promotion?: PieceSymbol) => {
      const fenBefore = game.fen;
      const ply = game.history.length + 1;
      const mv = game.makeMove(from, to, promotion);
      if (!mv) return false;
      playMoveSound(mv, true);
      setPreview(null);
      if (lessonRef.current) {
        tutorClient.noteTurnStart();
        tutorClient.trace(`student played ${mv.san}`);
        tutorClient.stop(); // whatever it was saying is about an older position now
        tutorClient.boardChanged();
        clearLive();
        setCoachArrows([]);
        setCoachSquares([]);
        tutorClient.noteActivity();
        const played: PlayedMove = { move: mv, fenBefore, ply };
        if (new Chess(mv.after).isGameOver()) {
          playSound("gameEnd", 0.35);
          pendingStudent.current = null;
          void commentOnTurn(played, null);
        } else {
          pendingStudent.current = played;
        }
      } else if (new Chess(mv.after).isGameOver()) {
        playSound("gameEnd", 0.35);
      }
      return true;
    },
    [game, tutorClient, commentOnTurn, clearLive],
  );

  // Tutor (engine) replies whenever it is its turn during a lesson. Keyed on the position, never on the `game`
  // object: while this effect depended on it, every render during the Professor's turn (each engine flush) restarted
  // it and queued one more search on the player worker, and the reply, then the comment, waited for the pile to drain.
  const historyLength = game.history.length;
  useEffect(() => {
    if (!lessonActive || game.status.over || game.turn === settings.userColor) return;
    let cancelled = false;
    const fenBefore = game.fen;
    const ply = historyLength + 1;
    const preset = STRENGTH_PRESETS.find((p) => p.id === settings.strength)!;
    const t0 = performance.now();
    (async () => {
      if (!pendingStudent.current) tutorClient.noteTurnStart(); // the Professor opens the game
      // Concurrently: the reply search and the analysis of the student's move (for its classification; the engine
      // leaves that position as soon as the reply is played).
      const [res] = await Promise.all([
        player.search(fenBefore, { depth: preset.depth, elo: preset.elo }),
        waitForAnalysis(fenBefore, 12, STUDENT_ANALYSIS_WAIT_MS),
      ]);
      if (cancelled || gameRef.current.fen !== fenBefore || res.bestmove === "(none)") return;
      // Played on a copy: the real board only gets the move when the Professor announces it.
      const u = parseUci(res.bestmove);
      let mv: Move | null = null;
      try {
        mv = new Chess(fenBefore).move({ from: u.from, to: u.to, promotion: u.promotion });
      } catch {
        mv = null;
      }
      if (!mv) return;
      tutorClient.trace(`Professor chose ${mv.san} in ${Math.round(performance.now() - t0)}ms, waiting for the announcement`);
      const played: PlayedMove = { move: mv, fenBefore, ply };
      armReply(played);
      const student = pendingStudent.current;
      pendingStudent.current = null;
      void commentOnTurn(student, played);
    })();
    return () => {
      cancelled = true;
      // Only this run's own reply: after it lands the effect re-runs with nothing of ours pending.
      if (pendingReply.current?.move.fenBefore === fenBefore) cancelReply();
    };
  }, [lessonActive, game.fen, game.status.over, game.turn, historyLength, settings.userColor, settings.strength, player, waitForAnalysis, commentOnTurn, tutorClient, armReply, cancelReply]);

  // ----- buttons -----
  const startLesson = async () => {
    warmCommentWriter();
    playSound("gameStart");
    cancelReply();
    game.reset();
    setResetKey((k) => k + 1);
    setCoachArrows([]);
    setCoachSquares([]);
    setPreview(null);
    clearLive();
    tutorClient.boardChanged();
    setFlipped(settings.userColor === "b");
    pendingStudent.current = null;
    previousComments.current = [];
    setLessonActive(true);
    if (tutor.state.status !== "off") await tutorClient.end();
    tutorClient.resetConversation();
    await tutorClient.start();
  };

  const newGame = async () => {
    playSound("gameStart");
    cancelReply();
    setHoveredEngineMove(null);
    setCoachArrows([]);
    setCoachSquares([]);
    setPreview(null);
    clearLive();
    tutorClient.boardChanged();
    game.reset();
    setResetKey((k) => k + 1);
    pendingStudent.current = null;
    previousComments.current = [];
    if (lessonActive && tutor.state.status !== "off") {
      await tutorClient.end();
      tutorClient.resetConversation();
      await tutorClient.start();
    }
  };

  const undo = () => {
    // A reply still waiting to be announced never happened, and he must stop announcing it.
    if (pendingReply.current && tutorClient.stop(stopUndoInstruction(langRef.current))) clearLive();
    cancelReply();
    setHoveredEngineMove(null);
    setCoachArrows([]);
    setCoachSquares([]);
    setPreview(null);
    clearLive();
    tutorClient.boardChanged();
    let undone = 0;
    pendingStudent.current = null;
    if (lessonActive) {
      // Take back the tutor's reply too, so it is the student's turn again.
      if (game.turn === settings.userColor && game.history.length >= 2) {
        if (game.undo()) undone++;
      }
      if (game.undo()) undone++;
    } else if (game.undo()) undone++;
    if (undone > 0) {
      playSound("undo");
      setResetKey((k) => k + 1);
      if (lessonActive) {
        const g = gameRef.current;
        const moves = g.history.map((m) => m.san).join(" ");
        tutorClient.sendThinking(
          langRef.current === "pt-BR"
            ? `O aluno desfez ${undone === 2 ? "o último par de lances" : "o último lance"}. Lances agora: ${moves || "(início)"}.`
            : `The student undid ${undone === 2 ? "the last pair of moves" : "the last move"}. Moves now: ${moves || "(start)"}.`,
        );
      }
    }
  };

  /**
   * Classification badge for the move just played, drawn on the square it landed on. It appears as soon as the engine
   * has evaluated the new position (the classification is "unknown" until then), and is hidden while the transcript
   * preview shows an older position.
   */
  const moveBadge = useMemo(() => {
    if (preview) return null;
    const to = game.lastMove?.to;
    if (!to) return null;
    const last = records[records.length - 1];
    if (!last || last.ply !== game.history.length || last.classification === "unknown") return null;
    return { square: to, classification: last.classification };
  }, [preview, game.lastMove, game.history.length, records]);

  const engineArrows = useMemo<Arrow[]>(
    () => (hoveredEngineMove ? [{ from: hoveredEngineMove.from, to: hoveredEngineMove.to, color: "engine" }] : []),
    [hoveredEngineMove],
  );

  // Coach layer: the transcript preview when hovering, otherwise live mentions plus tool-drawn annotations.
  const coachLayer = useMemo(() => {
    if (preview) {
      return visualsOf(
        preview.focus.map((m) => m.mention),
        preview.dim.map((m) => m.mention),
      );
    }
    const v = visualsOf(liveMentions.slice(-1), liveMentions.slice(0, -1));
    const squares = new Map(v.squares.map((c) => [c.square, c]));
    for (const sq of coachSquares) squares.set(sq, { square: sq, level: "focus" });
    return { squares: [...squares.values()], arrows: [...v.arrows, ...coachArrows] };
  }, [preview, liveMentions, coachSquares, coachArrows]);

  // While hovering the transcript the board shows the position of that moment, read-only.
  const previewPosition = useMemo(() => {
    if (!preview) return null;
    try {
      const chess = new Chess(preview.fen);
      return { board: chess.board(), turn: chess.turn(), checked: chess.inCheck() ? kingSquare(chess, chess.turn()) : null };
    } catch {
      return null;
    }
  }, [preview]);

  const showEngine = !game.status.over && (!lessonActive || settings.showEngine) && !previewPosition;
  const playable: Color[] = previewPosition ? [] : lessonActive ? [settings.userColor] : ["w", "b"];

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-[#312e2b] p-4 text-neutral-100 lg:flex-row lg:items-start lg:justify-center lg:p-8">
      <div className="flex w-full max-w-[min(92vw,calc(100vh-4rem))] gap-2 lg:max-w-[min(70vw,calc(100vh-4rem))]">
        <div className="aspect-square h-auto w-5 shrink-0 self-stretch">
          <EvalBar evaluation={currentEval} flipped={flipped} />
        </div>
        <div className="min-w-0 flex-1">
        <Board
          board={previewPosition?.board ?? game.board}
          turn={previewPosition?.turn ?? game.turn}
          flipped={flipped}
          gameOver={game.status.over}
          lastMove={previewPosition ? null : game.lastMove ? { from: game.lastMove.from, to: game.lastMove.to } : null}
          checkedKingSquare={previewPosition ? previewPosition.checked : game.checkedKingSquare}
          legalMoves={game.legalMoves}
          onMove={handleMove}
          resetKey={resetKey}
          engineArrows={engineArrows}
          coachArrows={coachLayer.arrows}
          coachSquares={coachLayer.squares}
          coachOpacity={liveFading && !preview ? 0 : 1}
          moveBadge={moveBadge}
          playableColors={playable}
        >
          {showEngine && <EnginePanel engine={engine} turn={game.turn} onHoverMove={setHoveredEngineMove} />}
          {previewPosition && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center">
              <span className="rounded-b bg-[#9b59b6]/90 px-3 py-1 text-xs font-semibold text-white shadow">
                {previewPosition.board === game.board || preview?.fen === game.fen ? t.currentPosition : t.positionWhenSaid}
              </span>
            </div>
          )}
        </Board>
        </div>
      </div>

      <aside className="flex w-full max-w-md flex-col overflow-hidden rounded-lg bg-[#262522] shadow-xl lg:h-[calc(100vh-4rem)] lg:w-96 lg:shrink-0">
        <div className="border-b border-white/10">
          <GameStatus status={game.status} />
        </div>

        {lessonActive ? (
          <CoachPanel
            state={tutor.state}
            costPerMinute={COST_PER_MINUTE}
            onTalk={talk}
            onEnd={() => void tutorClient.end()}
            onResume={() => void tutorClient.start()}
            onPreview={setPreview}
          />
        ) : (
          <LessonSetup settings={settings} onChange={setSettings} onStart={() => void startLesson()} disabled={false} />
        )}

        <MoveList records={records} />

        <div className="grid grid-cols-4 gap-2 border-t border-white/10 p-3">
          <button
            type="button"
            onClick={() => void newGame()}
            className="rounded-md bg-[#81b64c] px-3 py-2 text-sm font-semibold text-white shadow hover:bg-[#8fc75a] active:translate-y-px"
          >
            {game.history.length === 0 ? t.start : t.restart}
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={game.history.length === 0}
            className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40 active:translate-y-px"
          >
            {t.undo}
          </button>
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 active:translate-y-px"
          >
            {t.flip}
          </button>
          <button
            type="button"
            onClick={() => setSoundOn(!soundOn)}
            title={soundOn ? t.soundOff : t.soundOn}
            aria-pressed={soundOn}
            className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 active:translate-y-px"
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>

        {lessonActive && (
          <button
            type="button"
            onClick={() => {
              cancelReply();
              void tutorClient.end();
              setLessonActive(false);
            }}
            className="border-t border-white/10 px-3 py-2 text-left text-xs text-neutral-400 hover:text-neutral-200"
          >
            {t.leaveLesson}
          </button>
        )}

        <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-neutral-400">
          {t.help}
        </p>
      </aside>
    </main>
  );
}
