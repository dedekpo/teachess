"use client";

import { Chess, type Color, type Move } from "chess.js";
import type { CommentRequest, MoveInfo } from "@/app/api/live/comment/route";
import type { AnalysisSnapshot } from "@/lib/useEngine";
import { formatScoreWhite, summarizeLines } from "@/lib/engine-format";
import type { GameStatus } from "@/lib/useChessGame";
import { CLASS_LABEL_PT, materialSummary, recordsText, type MoveRecord } from "@/lib/game-record";

const COLOR_NAME = { w: "brancas", b: "pretas" } as const;

export function statusText(status: GameStatus): string {
  switch (status.kind) {
    case "checkmate":
      return `xeque-mate, vitória das ${COLOR_NAME[status.winner!]}`;
    case "stalemate":
      return "empate por afogamento";
    case "threefold":
      return "empate por tripla repetição";
    case "fifty-move":
      return "empate pela regra dos 50 lances";
    case "insufficient":
      return "empate por material insuficiente";
    case "check":
      return `${COLOR_NAME[status.turn]} a jogar, em xeque`;
    default:
      return `${COLOR_NAME[status.turn]} a jogar`;
  }
}

export function historyText(history: Move[]): string {
  const parts: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${history[i].san}${history[i + 1] ? ` ${history[i + 1].san}` : ""}`);
  }
  return parts.join(" ");
}

export function bestEval(snapshot: AnalysisSnapshot | undefined): string | null {
  if (!snapshot || !snapshot.fen || snapshot.lines.length === 0) return null;
  const turn = snapshot.fen.split(" ")[1] as Color;
  return formatScoreWhite(snapshot.lines[0].score, turn).text;
}

export interface MoveContext {
  move: Move;
  fenBefore: string;
  before: AnalysisSnapshot | undefined;
  after: AnalysisSnapshot | undefined;
  /** Annotated record of this move, when analysis was available. */
  record: MoveRecord | undefined;
  /** 1-based ply of the move in the game. */
  ply: number;
}

export function buildMoveInfo(ctx: MoveContext): MoveInfo {
  const r = ctx.record;
  return {
    san: ctx.move.san,
    moveNumber: Math.ceil(ctx.ply / 2),
    fenBefore: ctx.fenBefore,
    fenAfter: ctx.move.after,
    evalBefore: bestEval(ctx.before),
    evalAfter: bestEval(ctx.after),
    bestBefore: ctx.before ? summarizeLines(ctx.fenBefore, ctx.before.lines, 4) : [],
    bestAfter: ctx.after ? summarizeLines(ctx.move.after, ctx.after.lines, 4) : [],
    classification: r?.classification ?? "unknown",
    classificationPt: CLASS_LABEL_PT[r?.classification ?? "unknown"],
    loss: r?.loss === undefined || r.loss === null ? null : Number(r.loss.toFixed(2)),
    bestAlternative: r?.bestAlternative ?? null,
  };
}

export function buildCommentRequest(args: {
  userColor: Color;
  studentMove: MoveContext | null;
  tutorMove: MoveContext | null;
  history: Move[];
  fenNow: string;
  status: GameStatus;
  /** Annotated records of the game so far. */
  records: MoveRecord[];
  lessonNotes: string;
  conversation: CommentRequest["conversation"];
  previousComments: string[];
}): CommentRequest {
  return {
    userColor: args.userColor,
    studentMove: args.studentMove ? buildMoveInfo(args.studentMove) : null,
    tutorMove: args.tutorMove ? buildMoveInfo(args.tutorMove) : null,
    history: historyText(args.history),
    recentHistory: recordsText(args.records, 10),
    material: materialSummary(args.fenNow).text,
    gameStatus: statusText(args.status),
    lessonNotes: args.lessonNotes,
    conversation: args.conversation,
    previousComments: args.previousComments,
  };
}

/** Compact silent context for the live model about one move (kept well under 500 tokens). */
export function buildThinking(who: "student" | "tutor", info: MoveInfo, recentHistory: string, material: string, gameStatus: string): string {
  const name = who === "student" ? "O aluno" : "O Professor";
  const lines = info.bestAfter
    .slice(0, 3)
    .map((l) => `${l.move} (${l.eval})`)
    .join(", ");
  const verdict =
    info.classification === "unknown"
      ? ""
      : ` Classificação: ${info.classificationPt}${info.bestAlternative ? `; o melhor era ${info.bestAlternative}` : ""}.`;
  return (
    `${name} jogou ${info.san}.${verdict} ` +
    `Avaliação antes ${info.evalBefore ?? "?"}, depois ${info.evalAfter ?? "?"} (perspectiva das brancas). ` +
    `Últimos lances: ${recentHistory || "(início)"}. ` +
    `Material: ${material} ` +
    `Melhores lances agora: ${lines || "?"}. Situação: ${gameStatus}.`
  );
}

export async function fetchComment(req: CommentRequest): Promise<string | null> {
  try {
    const res = await fetch("/api/live/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { comment?: string };
    return data.comment?.trim() || null;
  } catch {
    return null;
  }
}

/** Parse a SAN or UCI move against a FEN. Returns null if illegal. */
export function tryMoveOnFen(fen: string, move: string): { san: string; fenAfter: string } | null {
  const chess = new Chess(fen);
  try {
    const mv = chess.move(move.trim());
    return { san: mv.san, fenAfter: chess.fen() };
  } catch {
    // maybe UCI
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(move.trim())) {
      try {
        const m = move.trim().toLowerCase();
        const mv = chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
        return { san: mv.san, fenAfter: chess.fen() };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function greetingInstruction(userColor: Color): string {
  const you = COLOR_NAME[userColor];
  const me = COLOR_NAME[userColor === "w" ? "b" : "w"];
  const opening =
    userColor === "w" ? "convide o aluno a fazer o primeiro lance" : "diga que você fará o primeiro lance";
  return `Cumprimente o aluno em português do Brasil em uma ou duas frases: diga que ele joga de ${you}, que você joga de ${me}, e ${opening}. Fale primeiro e depois ouça.`;
}
