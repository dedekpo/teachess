import type OpenAI from "openai";

/** Function tools declared to the backend model; they execute in the browser. */
export const TOOL_DEFINITIONS: OpenAI.Live.FunctionTool[] = [
  {
    type: "function",
    name: "get_position",
    description:
      "Retorna a posição atual (FEN, lado a jogar, cor do aluno, últimos lances anotados, estado da partida) e a memória da aula: lessonNotes (nome do aluno, abertura ou sistema que ele quer jogar, planos e preferências declarados) e studentSaid (últimas falas do aluno). Chame SEMPRE antes de responder.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_game_history",
    description:
      "Retorna a partida inteira anotada: cada lance com avaliação antes e depois (perspectiva das brancas), perda em peões, classificação (melhor lance, excelente, bom, imprecisão, erro, erro grave, brilhante) e o melhor lance alternativo quando o lance jogado não foi o melhor. Inclui os piores lances de cada lado. Use para perguntas como 'onde eu errei?', 'qual era o melhor lance?', 'como perdi a dama?'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_engine_lines",
    description:
      "Retorna as três melhores linhas do motor Stockfish para a posição atual, com avaliação na perspectiva das brancas (em peões; ou mate em N).",
    parameters: {
      type: "object",
      properties: {
        min_depth: { type: "integer", description: "Profundidade mínima desejada (padrão 12).", minimum: 6, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "evaluate_move",
    description:
      "Avalia um lance hipotético do lado a jogar na posição atual. Retorna se é legal, a avaliação após o lance e a melhor resposta do adversário.",
    parameters: {
      type: "object",
      properties: {
        move: { type: "string", description: "Lance em SAN (ex.: Nf3, exd5, O-O) ou UCI (ex.: g1f3)." },
      },
      required: ["move"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "draw_arrows",
    description: "Desenha setas no tabuleiro para o aluno ver uma ideia. Substitui setas anteriores do Professor.",
    parameters: {
      type: "object",
      properties: {
        arrows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Casa de origem, ex.: e2" },
              to: { type: "string", description: "Casa de destino, ex.: e4" },
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
    description: "Destaca casas no tabuleiro. Substitui destaques anteriores do Professor.",
    parameters: {
      type: "object",
      properties: {
        squares: { type: "array", items: { type: "string", description: "Casa, ex.: f7" } },
      },
      required: ["squares"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "clear_annotations",
    description: "Remove todas as setas e destaques desenhados pelo Professor.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

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
  /** Material on the board, described in Portuguese, plus the point balance. */
  material: string;
  materialBalance: number;
  pieces: { w: string[]; b: string[] };
  /** The last few moves, annotated (SAN, classification, evals, best alternative). */
  recentMoves: unknown[];
  lastMove: unknown | null;
  /** The student's last move, annotated. */
  lastStudentMove: unknown | null;
  /** Application memory about the student: name, chosen opening, declared plans, preferences. */
  lessonNotes: string;
  /** The student's most recent utterances, oldest first. */
  studentSaid: string[];
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
  evaluateMove(move: string): Promise<Record<string, unknown>>;
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
      const move = typeof args.move === "string" ? args.move : "";
      if (!move) return JSON.stringify({ error: "move is required" });
      return JSON.stringify(await ctx.evaluateMove(move));
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
