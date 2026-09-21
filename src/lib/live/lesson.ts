"use client";

import type { Color, Move } from "chess.js";
import type { CommentRequest, CommentVerification, MoveInfo } from "@/app/api/live/comment/route";
import type { AnalysisSnapshot } from "@/lib/useEngine";
import { formatScoreWhite, summarizeLines } from "@/lib/engine-format";
import type { GameStatus } from "@/lib/useChessGame";
import { CLASS_LABELS, materialSummary, recordsText, type MoveRecord } from "@/lib/game-record";
import type { Lang } from "@/lib/i18n/lang";
import type { PlanPart } from "@/lib/mentions/types";

const COLOR_NAME: Record<Lang, Record<Color, string>> = {
  en: { w: "White", b: "Black" },
  "pt-BR": { w: "brancas", b: "pretas" },
};

/** Game status as the models read it (the comment writer's fallback looks for "mate" / "draw" / "empate" in it). */
export function statusText(status: GameStatus, lang: Lang): string {
  const C = COLOR_NAME[lang];
  if (lang === "pt-BR") {
    switch (status.kind) {
      case "checkmate":
        return `xeque-mate, vitória das ${C[status.winner!]}`;
      case "stalemate":
        return "empate por afogamento";
      case "threefold":
        return "empate por tripla repetição";
      case "fifty-move":
        return "empate pela regra dos 50 lances";
      case "insufficient":
        return "empate por material insuficiente";
      case "check":
        return `${C[status.turn]} a jogar, em xeque`;
      default:
        return `${C[status.turn]} a jogar`;
    }
  }
  switch (status.kind) {
    case "checkmate":
      return `checkmate, ${C[status.winner!]} wins`;
    case "stalemate":
      return "draw by stalemate";
    case "threefold":
      return "draw by threefold repetition";
    case "fifty-move":
      return "draw by the fifty-move rule";
    case "insufficient":
      return "draw by insufficient material";
    case "check":
      return `${C[status.turn]} to move, in check`;
    default:
      return `${C[status.turn]} to move`;
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

export function buildMoveInfo(ctx: MoveContext, lang: Lang): MoveInfo {
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
    classificationLabel: CLASS_LABELS[lang][r?.classification ?? "unknown"],
    loss: r?.loss === undefined || r.loss === null ? null : Number(r.loss.toFixed(2)),
    bestAlternative: r?.bestAlternative ?? null,
  };
}

export function buildCommentRequest(args: {
  lang: Lang;
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
    lang: args.lang,
    userColor: args.userColor,
    studentMove: args.studentMove ? buildMoveInfo(args.studentMove, args.lang) : null,
    tutorMove: args.tutorMove ? buildMoveInfo(args.tutorMove, args.lang) : null,
    history: historyText(args.history),
    recentHistory: recordsText(args.records, args.lang, 10),
    material: materialSummary(args.fenNow, args.lang).text,
    gameStatus: statusText(args.status, args.lang),
    lessonNotes: args.lessonNotes,
    conversation: args.conversation,
    previousComments: args.previousComments,
  };
}

export interface CommentResult {
  comment: string;
  /** The speech split into text and the pieces/moves it refers to (for board highlights). */
  parts: PlanPart[];
  /** How the comment was obtained: attempts, what the board rejected, whether this is the plain fallback. */
  verification: CommentVerification | null;
}

export async function fetchComment(req: CommentRequest): Promise<CommentResult | null> {
  try {
    const res = await fetch("/api/live/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { comment?: string; parts?: PlanPart[]; verification?: CommentVerification };
    const comment = data.comment?.trim();
    if (!comment) return null;
    return {
      comment,
      parts: Array.isArray(data.parts) ? data.parts : [{ type: "text", text: comment }],
      verification: data.verification ?? null,
    };
  } catch {
    return null;
  }
}

/** One line for the events panel about how the comment was obtained; empty when the first answer simply passed. */
export function verificationTrace(v: CommentVerification | null): string {
  if (!v) return "";
  const problems = v.problems.length ? ` (${v.problems.join("; ")})` : "";
  if (v.fallback) return `plain announcement by the app: writer ${v.error ? `failed: ${v.error}` : `rejected ${v.attempts}×`}${problems}`;
  if (v.attempts > 1) return `corrected on attempt ${v.attempts}${problems}`;
  return "";
}

/** Boots the comment route (compilation in dev, cold start in production) before the first turn needs it. */
export function warmCommentWriter(): void {
  void fetch("/api/live/comment", { method: "GET" }).catch(() => undefined);
}

export function greetingInstruction(userColor: Color, lang: Lang): string {
  const you = COLOR_NAME[lang][userColor];
  const me = COLOR_NAME[lang][userColor === "w" ? "b" : "w"];
  if (lang === "pt-BR") {
    const opening = userColor === "w" ? "convide o aluno a fazer o primeiro lance" : "diga que você fará o primeiro lance";
    return `Cumprimente o aluno em português do Brasil em uma ou duas frases: diga que ele joga de ${you}, que você joga de ${me}, e ${opening}. Fale primeiro e depois ouça.`;
  }
  const opening = userColor === "w" ? "invite the student to make the first move" : "say that you will make the first move";
  return `Greet the student in English in one or two sentences: say that they play ${you}, that you play ${me}, and ${opening}. Speak first, then listen.`;
}
