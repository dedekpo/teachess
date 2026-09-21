import type OpenAI from "openai";
import type { Lang } from "@/lib/i18n/lang";

/** Descriptions the backend model reads, per language (names and parameters are the same). */
const TEXT = {
  en: {
    get_position:
      "Returns the current position (FEN, side to move, the student's colour, each side's pieces, pieceTypesNeedingSquare, the last annotated moves, game status), candidateMoves (ALL legal moves already evaluated by the engine, best to worst, with evaluation, the opponent's best reply and a short continuation), legalMovesByPiece (the same legal moves grouped by piece, e.g. \"Qd1\": [\"Qxd8+\", \"Qd2\"]; a move that is not here is IMPOSSIBLE) and the lesson memory: lessonNotes (the student's name, the opening or system they want to play, declared plans and preferences) and studentSaid (the student's latest utterances). It may bring pendingTutorMove: the move the Professor has just announced that is not on the board yet; in that case candidateMoves and legalMovesByPiece are already for the position after that move. ALWAYS call it before answering; for most questions it is the only tool needed.",
    get_game_history:
      "Returns the whole annotated game: every move with the evaluation before and after (White's perspective), loss in pawns, classification (best move, excellent, good, inaccuracy, mistake, blunder, brilliant) and the best alternative move when the move played was not the best. Includes each side's worst moves. Use it for questions like 'where did I go wrong?', 'what was the best move?', 'how did I lose my queen?'.",
    get_engine_lines: "Returns the Stockfish engine's three best lines for the current position, deeper than candidateMoves. Only needed when candidateMoves is empty or candidateDepth is below 8.",
    min_depth: "Minimum search depth wanted (default 12).",
    evaluate_move:
      "Evaluates a hypothetical sequence from the current position (the first move is the side to move's, then alternating). For ONE move, prefer candidateMoves and legalMovesByPiece from get_position, which already have them all. Use this tool for sequences of several moves ('if I play X, he answers Y and I play Z'). If any move of the sequence is impossible, the answer brings legal: false, which move failed (illegalMove), the reason and what that piece can do.",
    moves: "Sequence of moves in SAN (e.g. [\"Nf3\", \"Nc6\", \"Bb5\"]) or UCI, starting with the side to move.",
    draw_arrows: "Draws arrows on the board so the student can see an idea. Replaces the Professor's earlier arrows.",
    from: "Origin square, e.g. e2",
    to: "Destination square, e.g. e4",
    highlight_squares: "Highlights squares on the board. Replaces the Professor's earlier highlights.",
    square: "Square, e.g. f7",
    clear_annotations: "Removes every arrow and highlight drawn by the Professor.",
  },
  "pt-BR": {
    get_position:
      "Retorna a posição atual (FEN, lado a jogar, cor do aluno, peças de cada lado, pieceTypesNeedingSquare, últimos lances anotados, estado da partida), candidateMoves (TODOS os lances legais já avaliados pelo motor, do melhor ao pior, com avaliação, melhor resposta do adversário e continuação curta), legalMovesByPiece (os mesmos lances legais agrupados por peça, ex.: \"Qd1\": [\"Qxd8+\", \"Qd2\"]; um lance que não está aqui é IMPOSSÍVEL) e a memória da aula: lessonNotes (nome do aluno, abertura ou sistema que ele quer jogar, planos e preferências declarados) e studentSaid (últimas falas do aluno). Pode trazer pendingTutorMove: o lance que o Professor acabou de anunciar e que ainda vai aparecer no tabuleiro; nesse caso candidateMoves e legalMovesByPiece já são da posição depois desse lance. Chame SEMPRE antes de responder; na maioria das perguntas é a única ferramenta necessária.",
    get_game_history:
      "Retorna a partida inteira anotada: cada lance com avaliação antes e depois (perspectiva das brancas), perda em peões, classificação (melhor lance, excelente, bom, imprecisão, erro, erro grave, brilhante) e o melhor lance alternativo quando o lance jogado não foi o melhor. Inclui os piores lances de cada lado. Use para perguntas como 'onde eu errei?', 'qual era o melhor lance?', 'como perdi a dama?'.",
    get_engine_lines: "Retorna as três melhores linhas do motor Stockfish para a posição atual, mais profundas que candidateMoves. Só necessária quando candidateMoves está vazio ou candidateDepth é menor que 8.",
    min_depth: "Profundidade mínima desejada (padrão 12).",
    evaluate_move:
      "Avalia uma sequência hipotética a partir da posição atual (o primeiro lance é do lado a jogar, depois alternando). Para UM lance, prefira candidateMoves e legalMovesByPiece de get_position, que já têm todos. Use esta ferramenta para sequências de vários lances ('se eu jogar X, ele responde Y e eu jogo Z'). Se algum lance da sequência for impossível, a resposta traz legal: false, qual lance falhou (illegalMove), o motivo e o que aquela peça pode fazer.",
    moves: "Sequência de lances em SAN (ex.: [\"Nf3\", \"Nc6\", \"Bb5\"]) ou UCI, começando pelo lado a jogar.",
    draw_arrows: "Desenha setas no tabuleiro para o aluno ver uma ideia. Substitui setas anteriores do Professor.",
    from: "Casa de origem, ex.: e2",
    to: "Casa de destino, ex.: e4",
    highlight_squares: "Destaca casas no tabuleiro. Substitui destaques anteriores do Professor.",
    square: "Casa, ex.: f7",
    clear_annotations: "Remove todas as setas e destaques desenhados pelo Professor.",
  },
} satisfies Record<Lang, unknown>;

/** Function tools declared to the backend model; they execute in the browser. */
export function toolDefinitions(lang: Lang): OpenAI.Live.FunctionTool[] {
  const T = TEXT[lang];
  return [
    {
      type: "function",
      name: "get_position",
      description: T.get_position,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "get_game_history",
      description: T.get_game_history,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "get_engine_lines",
      description: T.get_engine_lines,
      parameters: {
        type: "object",
        properties: {
          min_depth: { type: "integer", description: T.min_depth, minimum: 6, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "evaluate_move",
      description: T.evaluate_move,
      parameters: {
        type: "object",
        properties: {
          moves: { type: "array", items: { type: "string" }, description: T.moves },
        },
        required: ["moves"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "draw_arrows",
      description: T.draw_arrows,
      parameters: {
        type: "object",
        properties: {
          arrows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: T.from },
                to: { type: "string", description: T.to },
              },
              required: ["from", "to"],
              additionalProperties: false,
            },
          },
        },
        required: ["arrows"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "highlight_squares",
      description: T.highlight_squares,
      parameters: {
        type: "object",
        properties: {
          squares: { type: "array", items: { type: "string", description: T.square } },
        },
        required: ["squares"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "clear_annotations",
      description: T.clear_annotations,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

export interface EngineLineSummary {
  move: string; // SAN
  eval: string; // "+0.5" / "M3" from White's perspective
  line: string[]; // SAN continuation
}

export interface PositionSummary {
  fen: string;
  turn: "w" | "b";
  userColor: "w" | "b";
  status: string;
  /** Current evaluation from White's perspective, e.g. "+1.2" or "M3". */
  evaluation: string | null;
  /** Material on the board, described in the lesson language, plus the point balance. */
  material: string;
  materialBalance: number;
  pieces: { w: string[]; b: string[] };
  /** Piece types each side has more than one of: when naming one of these, the square must be said ("pawn on c2"). */
  pieceTypesNeedingSquare: { w: string[]; b: string[] };
  /** The last few moves, annotated (SAN, classification, evals, best alternative). */
  recentMoves: unknown[];
  lastMove: unknown | null;
  /** The student's last move, annotated. */
  lastStudentMove: unknown | null;
  /** Application memory about the student: name, chosen opening, declared plans, preferences. */
  lessonNotes: string;
  /** The student's most recent utterances, oldest first. */
  studentSaid: string[];
  /** Every legal move pre-evaluated by the local engine, best first (may be empty if not ready). */
  candidateMoves: { move: string; eval: string; bestReply: string | null; line: string[] }[];
  /** Search depth of candidateMoves (0 when not ready). */
  candidateDepth: number;
  /** Every legal move grouped by the piece that makes it ("Qd1": ["Qxd8+", "Qd2", ...]); a move not here is impossible. */
  legalMovesByPiece: Record<string, string[]>;
  /** A reply the Professor has announced but that is not on the board yet (SAN), or null. */
  pendingTutorMove: string | null;
}

export interface GameHistorySummary {
  moves: unknown[];
  worstStudentMoves: unknown[];
  worstTutorMoves: unknown[];
  material: string;
}

/** Callbacks the page provides so tools can read the board and draw on it. */
export interface ToolContext {
  getPosition(): PositionSummary;
  getGameHistory(): GameHistorySummary;
  getEngineLines(minDepth: number): Promise<{ depth: number; lines: EngineLineSummary[] }>;
  evaluateLine(moves: string[]): Promise<Record<string, unknown>>;
  setCoachAnnotations(update: { arrows?: { from: string; to: string }[]; squares?: string[]; clear?: boolean }): void;
}

const SQUARE_RE = /^[a-h][1-8]$/;

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: "invalid JSON arguments" });
  }

  switch (name) {
    case "get_position":
      return JSON.stringify(ctx.getPosition());
    case "get_game_history":
      return JSON.stringify(ctx.getGameHistory());
    case "get_engine_lines": {
      const minDepth = typeof args.min_depth === "number" ? args.min_depth : 12;
      return JSON.stringify(await ctx.getEngineLines(minDepth));
    }
    case "evaluate_move": {
      const moves = Array.isArray(args.moves)
        ? (args.moves as unknown[]).filter((m): m is string => typeof m === "string" && m.trim() !== "")
        : typeof args.move === "string" && args.move.trim()
          ? [args.move]
          : [];
      if (moves.length === 0) return JSON.stringify({ error: "moves is required" });
      return JSON.stringify(await ctx.evaluateLine(moves));
    }
    case "draw_arrows": {
      const arrows = Array.isArray(args.arrows)
        ? (args.arrows as { from?: unknown; to?: unknown }[])
            .filter((a) => typeof a.from === "string" && typeof a.to === "string")
            .map((a) => ({ from: (a.from as string).toLowerCase(), to: (a.to as string).toLowerCase() }))
            .filter((a) => SQUARE_RE.test(a.from) && SQUARE_RE.test(a.to))
        : [];
      ctx.setCoachAnnotations({ arrows });
      return JSON.stringify({ ok: true, drawn: arrows.length });
    }
    case "highlight_squares": {
      const squares = Array.isArray(args.squares)
        ? (args.squares as unknown[])
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.toLowerCase())
            .filter((s) => SQUARE_RE.test(s))
        : [];
      ctx.setCoachAnnotations({ squares });
      return JSON.stringify({ ok: true, highlighted: squares.length });
    }
    case "clear_annotations":
      ctx.setCoachAnnotations({ clear: true });
      return JSON.stringify({ ok: true });
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}
