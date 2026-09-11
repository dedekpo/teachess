"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { Board } from "@/components/Board";
import { CoachPanel } from "@/components/CoachPanel";
import { EnginePanel, type UciMove } from "@/components/EnginePanel";
import { EvalBar } from "@/components/EvalBar";
import { GameStatus } from "@/components/GameStatus";
import { LessonSetup, type LessonSettings } from "@/components/LessonSetup";
import { MoveList } from "@/components/MoveList";
import { EnginePlayer, STRENGTH_PRESETS } from "@/lib/engine-player";
import { formatScoreWhite, parseUci, pvToSan, summarizeLines } from "@/lib/engine-format";
import {
  buildCommentRequest,
  buildMoveInfo,
  buildThinking,
  fetchComment,
  greetingInstruction,
  statusText,
  tryMoveOnFen,
  type MoveContext,
} from "@/lib/live/lesson";
import { DEFAULT_VOICE } from "@/lib/live/session-config";
import type { ToolContext } from "@/lib/live/tools";
import { notesThinking, updateLessonNotes } from "@/lib/live/notes";
import { useLiveTutor } from "@/lib/live/useLiveTutor";
import { useChessGame } from "@/lib/useChessGame";
import { useEngine } from "@/lib/useEngine";
import { buildRecords, materialSummary, positionEvalFromSnapshot, recordToJson, recordsText, worstMoves } from "@/lib/game-record";
import type { Arrow } from "@/lib/chess-utils";

const COST_PER_MINUTE = 0.05;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function Home() {
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
  const [settings, setSettings] = useState<LessonSettings>({
    userColor: "w",
    strength: "intermediario",
    voice: DEFAULT_VOICE,
    idleTimeoutSec: 90,
    showEngine: false,
  });
  const [lessonActive, setLessonActive] = useState(false);
  const [coachArrows, setCoachArrows] = useState<Arrow[]>([]);
  const [coachSquares, setCoachSquares] = useState<Square[]>([]);
  const [player] = useState(() => new EnginePlayer());
  useEffect(() => () => player.dispose(), [player]);

  // Latest values readable from async callbacks.
  const gameRef = useRef(game);
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
        const material = materialSummary(g.fen);
        const evaluation = positionEvalFromSnapshot(engineRef.current.analyses.get(g.fen));
        const lastStudent = [...recs].reverse().find((r) => r.color === userColor);
        return {
          fen: g.fen,
          turn: g.turn,
          userColor,
          status: statusText(g.status),
          evaluation: evaluation?.text ?? null,
          material: material.text,
          materialBalance: material.balance,
          pieces: material.pieces,
          recentMoves: recs.slice(-8).map(recordToJson),
          lastMove: recs.length ? recordToJson(recs[recs.length - 1]) : null,
          lastStudentMove: lastStudent ? recordToJson(lastStudent) : null,
          lessonNotes: notesRef.current || "(nenhuma ainda)",
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
          moves: recs.map(recordToJson),
          worstStudentMoves: worstMoves(recs, userColor),
          worstTutorMoves: worstMoves(recs, userColor === "w" ? "b" : "w"),
          material: materialSummary(gameRef.current.fen).text,
        };
      },
      getEngineLines: async (minDepth) => {
        const fen = gameRef.current.fen;
        const snap = await waitForAnalysis(fen, minDepth, 3000);
        if (!snap) return { depth: 0, lines: [] };
        return { depth: snap.depth, lines: summarizeLines(fen, snap.lines, 6) };
      },
      evaluateMove: async (move) => {
        const fen = gameRef.current.fen;
        const attempt = tryMoveOnFen(fen, move);
        if (!attempt) return { legal: false, move };
        const res = await player.search(attempt.fenAfter, { depth: 12 });
        const turnAfter = attempt.fenAfter.split(" ")[1] as Color;
        const evalAfter = res.score ? formatScoreWhite(res.score, turnAfter).text : null;
        const reply = res.bestmove !== "(none)" ? pvToSan(attempt.fenAfter, [res.bestmove], 1)[0] ?? null : null;
        const line = pvToSan(attempt.fenAfter, res.pv, 5);
        return { legal: true, move: attempt.san, evalAfter, bestReply: reply, line };
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
    [player, waitForAnalysis, latestRecords],
  );

  const tutor = useLiveTutor({
    tools,
    idleTimeoutMs: settings.idleTimeoutSec * 1000,
    buildOptions: () => {
      const g = gameRef.current;
      const s = settingsRef.current;
      const preset = STRENGTH_PRESETS.find((p) => p.id === s.strength)!;
      return {
        voice: s.voice,
        userColor: s.userColor,
        initialContext:
          `Configuração da aula: o aluno joga de ${s.userColor === "w" ? "brancas" : "pretas"}; ` +
          `nível do Professor: ${preset.label}. Lances até agora: ${g.history.map((m) => m.san).join(" ") || "(nenhum)"}. ` +
          `Situação: ${statusText(g.status)}.` +
          (notesRef.current ? ` Notas da aula: ${notesRef.current}` : ""),
      };
    },
    onFreshSession: () => {
      tutor.client.sendInstructions(greetingInstruction(settingsRef.current.userColor));
    },
    onUserUtterance: (text, before) => {
      void (async () => {
        const notes = await updateLessonNotes({ notes: notesRef.current, utterance: text, professorBefore: before });
        if (notes === null || notes === notesRef.current) return;
        notesRef.current = notes;
        tutor.client.sendThinking(notesThinking(notes));
      })();
    },
  });
  const tutorClient = tutor.client;
  const tutorClientRef = useRef(tutorClient);
  tutorClientRef.current = tutorClient;

  // ----- per-turn commentary -----
  type PlayedMove = { move: Move; fenBefore: string; ply: number };
  /** The student's move awaiting the Professor's reply, so one comment covers the whole turn. */
  const pendingStudent = useRef<PlayedMove | null>(null);
  /** What the Professor already said about earlier turns (so the writer does not repeat itself). */
  const previousComments = useRef<string[]>([]);

  const moveContext = useCallback(
    async (m: PlayedMove, waitMs: number): Promise<MoveContext> => {
      const before = engineRef.current.analyses.get(m.fenBefore);
      const after = await waitForAnalysis(m.move.after, 12, waitMs);
      const record = latestRecords().find((r) => r.ply === m.ply && r.san === m.move.san);
      return { move: m.move, fenBefore: m.fenBefore, before, after, record, ply: m.ply };
    },
    [waitForAnalysis, latestRecords],
  );

  /** Silent context for the live model about a move just played. */
  const thinkOn = useCallback(
    async (who: "student" | "tutor", m: PlayedMove) => {
      const ctx = await moveContext(m, 1500);
      const g = gameRef.current;
      const recs = latestRecords().filter((r) => r.ply <= g.history.length);
      tutorClient.sendThinking(
        buildThinking(who, buildMoveInfo(ctx), recordsText(recs, 10), materialSummary(g.fen).text, statusText(g.status)),
      );
    },
    [moveContext, latestRecords, tutorClient],
  );

  /** One spoken comment for the turn. Dropped if the board has moved on by the time it is ready. */
  const commentOnTurn = useCallback(
    async (student: PlayedMove | null, tutor: PlayedMove | null) => {
      const target = tutor ?? student;
      if (!target) return;
      const fenTarget = target.move.after;
      const [studentCtx, tutorCtx] = await Promise.all([
        student ? moveContext(student, 2500) : null,
        tutor ? moveContext(tutor, 1500) : null,
      ]);
      const g = gameRef.current;
      if (g.fen !== fenTarget) return; // the student already moved on
      const req = buildCommentRequest({
        userColor: settingsRef.current.userColor,
        studentMove: studentCtx,
        tutorMove: tutorCtx,
        history: g.history,
        fenNow: g.fen,
        status: g.status,
        records: latestRecords().filter((r) => r.ply <= g.history.length),
        lessonNotes: notesRef.current,
        conversation: tutorClient
          .getSnapshot()
          .transcript.slice(-8)
          .map((r) => ({ role: r.role === "user" ? "student" : "professor", text: r.text })),
        previousComments: previousComments.current.slice(-3),
      });
      const comment = await fetchComment(req);
      if (!comment) return;
      if (gameRef.current.fen !== fenTarget) return; // moved on while the writer worked
      tutorClient.sendCommentary(comment);
      previousComments.current = [...previousComments.current.slice(-5), comment];
    },
    [moveContext, latestRecords, tutorClient],
  );

  // ----- moves -----
  const handleMove = useCallback(
    (from: Square, to: Square, promotion?: PieceSymbol) => {
      const fenBefore = game.fen;
      const ply = game.history.length + 1;
      const mv = game.makeMove(from, to, promotion);
      if (!mv) return false;
      if (lessonRef.current) {
        tutorClient.stop(); // whatever it was saying is about an older position now
        setCoachArrows([]);
        setCoachSquares([]);
        tutorClient.noteActivity();
        const played: PlayedMove = { move: mv, fenBefore, ply };
        void thinkOn("student", played);
        if (new Chess(mv.after).isGameOver()) {
          pendingStudent.current = null;
          void commentOnTurn(played, null);
        } else {
          pendingStudent.current = played;
        }
      }
      return true;
    },
    [game, tutorClient, thinkOn, commentOnTurn],
  );

  // Tutor (engine) replies whenever it is its turn during a lesson.
  useEffect(() => {
    if (!lessonActive || game.status.over || game.turn === settings.userColor) return;
    let cancelled = false;
    const fenBefore = game.fen;
    const ply = game.history.length + 1;
    const preset = STRENGTH_PRESETS.find((p) => p.id === settings.strength)!;
    (async () => {
      // Let the analysis of the student's move settle (for its classification) while the opponent engine searches.
      const [, res] = await Promise.all([
        waitForAnalysis(fenBefore, 12, 2000),
        player.search(fenBefore, { depth: preset.depth, elo: preset.elo }),
      ]);
      if (cancelled || gameRef.current.fen !== fenBefore || res.bestmove === "(none)") return;
      await delay(300);
      if (cancelled || gameRef.current.fen !== fenBefore) return;
      const u = parseUci(res.bestmove);
      const mv = game.makeMove(u.from, u.to, u.promotion);
      if (!mv) return;
      const played: PlayedMove = { move: mv, fenBefore, ply };
      const student = pendingStudent.current;
      pendingStudent.current = null;
      void thinkOn("tutor", played);
      void commentOnTurn(student, played);
    })();
    return () => {
      cancelled = true;
    };
  }, [lessonActive, game.fen, game.status.over, game.turn, settings.userColor, settings.strength, game, player, waitForAnalysis, thinkOn, commentOnTurn]);

  // ----- buttons -----
  const startLesson = async () => {
    game.reset();
    setResetKey((k) => k + 1);
    setCoachArrows([]);
    setCoachSquares([]);
    setFlipped(settings.userColor === "b");
    pendingStudent.current = null;
    previousComments.current = [];
    setLessonActive(true);
    if (tutor.state.status !== "off") await tutorClient.end();
    tutorClient.resetConversation();
    await tutorClient.start();
  };

  const newGame = async () => {
    setHoveredEngineMove(null);
    setCoachArrows([]);
    setCoachSquares([]);
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
    setHoveredEngineMove(null);
    setCoachArrows([]);
    setCoachSquares([]);
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
      setResetKey((k) => k + 1);
      if (lessonActive) {
        const g = gameRef.current;
        tutorClient.sendThinking(
          `O aluno desfez ${undone === 2 ? "o último par de lances" : "o último lance"}. Lances agora: ${g.history.map((m) => m.san).join(" ") || "(início)"}.`,
        );
      }
    }
  };

  const engineArrows = useMemo<Arrow[]>(() => {
    const hover: Arrow[] = hoveredEngineMove
      ? [{ from: hoveredEngineMove.from, to: hoveredEngineMove.to, color: "engine" }]
      : [];
    return [...coachArrows, ...hover];
  }, [hoveredEngineMove, coachArrows]);

  const showEngine = !game.status.over && (!lessonActive || settings.showEngine);
  const playable: Color[] = lessonActive ? [settings.userColor] : ["w", "b"];

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-[#312e2b] p-4 text-neutral-100 lg:flex-row lg:items-start lg:justify-center lg:p-8">
      <div className="flex w-full max-w-[min(92vw,calc(100vh-4rem))] gap-2 lg:max-w-[min(70vw,calc(100vh-4rem))]">
        <div className="aspect-square h-auto w-5 shrink-0 self-stretch">
          <EvalBar evaluation={currentEval} flipped={flipped} />
        </div>
        <div className="min-w-0 flex-1">
        <Board
          board={game.board}
          turn={game.turn}
          flipped={flipped}
          gameOver={game.status.over}
          lastMove={game.lastMove ? { from: game.lastMove.from, to: game.lastMove.to } : null}
          checkedKingSquare={game.checkedKingSquare}
          legalMoves={game.legalMoves}
          onMove={handleMove}
          resetKey={resetKey}
          engineArrows={engineArrows}
          coachSquares={coachSquares}
          playableColors={playable}
        >
          {showEngine && <EnginePanel engine={engine} turn={game.turn} onHoverMove={setHoveredEngineMove} />}
        </Board>
        </div>
      </div>

      <aside className="flex w-full max-w-md flex-col overflow-hidden rounded-lg bg-[#262522] shadow-xl lg:h-[calc(100vh-4rem)] lg:w-96">
        <div className="border-b border-white/10">
          <GameStatus status={game.status} />
        </div>

        {lessonActive ? (
          <CoachPanel
            state={tutor.state}
            costPerMinute={COST_PER_MINUTE}
            onToggleMute={() => tutorClient.setMuted(!tutor.state.muted)}
            onEnd={() => void tutorClient.end()}
            onResume={() => void tutorClient.start()}
          />
        ) : (
          <LessonSetup settings={settings} onChange={setSettings} onStart={() => void startLesson()} disabled={false} />
        )}

        <MoveList records={records} />

        <div className="grid grid-cols-3 gap-2 border-t border-white/10 p-3">
          <button
            type="button"
            onClick={() => void newGame()}
            className="rounded-md bg-[#81b64c] px-3 py-2 text-sm font-semibold text-white shadow hover:bg-[#8fc75a] active:translate-y-px"
          >
            {game.history.length === 0 ? "Start" : "Restart"}
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={game.history.length === 0}
            className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40 active:translate-y-px"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 active:translate-y-px"
          >
            Flip
          </button>
        </div>

        {lessonActive && (
          <button
            type="button"
            onClick={() => {
              void tutorClient.end();
              setLessonActive(false);
            }}
            className="border-t border-white/10 px-3 py-2 text-left text-xs text-neutral-400 hover:text-neutral-200"
          >
            Sair do modo aula (voltar ao tabuleiro livre)
          </button>
        )}

        <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-neutral-400">
          Drag or click to move. Right-click a square to highlight it, right-drag to draw an arrow
          (hold Shift / Alt / Ctrl for other colors). Left-click clears annotations.
        </p>
      </aside>
    </main>
  );
}
