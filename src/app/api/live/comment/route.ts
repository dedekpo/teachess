import OpenAI from "openai";
import { NextResponse } from "next/server";
import { BACKEND_MODEL } from "@/lib/live/session-config";
import { parseLang, type Lang } from "@/lib/i18n/lang";
import { describeMove } from "@/lib/mentions/describe";
import { qualifyPieceParts } from "@/lib/mentions/qualify";
import { speechFromParts } from "@/lib/mentions/resolve";
import type { PlanPart, WriterPart } from "@/lib/mentions/types";
import { verifyWriterParts, type Problem, type TurnPositions } from "@/lib/mentions/validate";

export const runtime = "nodejs";

/** Engine-derived facts about one move. */
export interface MoveInfo {
  san: string;
  moveNumber: number;
  fenBefore: string;
  fenAfter: string;
  /** Evaluation (White's perspective) before the move. */
  evalBefore: string | null;
  /** Evaluation (White's perspective) after the move. */
  evalAfter: string | null;
  /** Top engine lines before the move (what could have been played). */
  bestBefore: { move: string; eval: string; line: string[] }[];
  /** Top engine lines after the move (what comes next). */
  bestAfter: { move: string; eval: string; line: string[] }[];
  /** Pre-computed classification of the move (trust it). */
  classification: string; // best, excellent, good, inaccuracy, mistake, blunder, brilliant, unknown
  classificationLabel: string;
  /** Pawns lost versus the best move (from the mover's perspective). */
  loss: number | null;
  /** The engine's best move in the position before, when different from the move played. */
  bestAlternative: string | null;
}

/**
 * One spoken comment covers a whole turn: the student's move (if any) and the
 * Professor's reply (if any). Either can be null: the Professor moves first when the
 * student plays Black, and there is no reply when the student's move ends the game.
 */
export interface CommentRequest {
  /** Language of the speech (and of every text field below). */
  lang: Lang;
  userColor: "w" | "b";
  studentMove: MoveInfo | null;
  tutorMove: MoveInfo | null;
  /** Full move list so far, e.g. "1. e4 e5 2. Nf3 Nc6". */
  history: string;
  /** The last few moves annotated, oldest first. */
  recentHistory: string;
  /** Material currently on the board, in the lesson language, including which pieces each side no longer has. */
  material: string;
  gameStatus: string;
  /** Application memory about the student: name, chosen opening, declared plans, preferences. */
  lessonNotes: string;
  /** Recent spoken conversation (student and Professor), oldest first. */
  conversation: { role: "student" | "professor"; text: string }[];
  /** The last comments the Professor already said about earlier moves, oldest first. */
  previousComments: string[];
}

const INSTRUCTIONS: Record<Lang, string> = {
  en: `You write what the Professor, a chess tutor, is going to say aloud in English. The Professor plays against the student and teaches with the Socratic method. Each request covers a whole turn: the student's move (studentMove) and the Professor's reply (tutorMove). Either can be null.

Form: at most 50 words, two or three short sentences, warm and direct. No lists, no markdown. Never use raw algebraic notation: name pieces (king, queen, rook, bishop, knight, pawn) and spell out squares ("knight to f3", "pawn on e5"). Evaluations are from White's perspective.

Identifying pieces: whenever the side has more than one piece of the kind named, the mention's text MUST include the piece's square: "your pawn on c2", "my knight on f6", "the rook on a1". Never say just "your pawn" or "the knight" when there are two or more. Leave the square out only when it is the side's only piece of that kind (the king; the queen, when there is a single one). For a piece that has just been captured or that moved this turn, say the square it was on ("I captured your pawn on d5"). Check the squares in "material".

Structure: first a short reaction to the student's move, then announce the Professor's move in words with a brief hint of the idea or the threat, without revealing the student's best reply. NEVER suggest or hint at the student's next move ("now the best is...", "you can play...", "your queen can capture..."): they only get suggestions when asking. Talking about the better move is only allowed in the past tense, about the move they just played (rules below). If studentMove is null, only announce the Professor's move. If tutorMove is null, comment only on the student's move.

Truth on the board: you cannot see the board, so only state what is in the data. Every move the speech describes, marked as a "line" or not, must be a possible move in the indicated position; every piece named must be on the square said. The app checks every claim on the board and rejects the whole answer if it finds an impossible move, a piece on the wrong square or a move suggestion for the student. When in doubt whether a move exists, do not mention it.

Reaction to the student's move, using the classification already computed in studentMove.classification (do not recompute it):
- best/excellent/brilliant: brief praise (if brilliant, say it was a bold sacrifice).
- good: a short, neutral remark, or none.
- inaccuracy: say it is not bad, point to the piece that had something better (bestAlternative) without giving the square.
- mistake/blunder: be honest and kind, say the better move (bestAlternative) in words and explain the reason in a few words using bestBefore.
Check "material" before mentioning any piece: never talk about a piece the side no longer has. Use "recentHistory" to refer to earlier moves when relevant.

Questions: ask at most ONE question, and only when it adds something concrete (a threat to see, a mistake to understand). On most normal turns, ask no question at all: end by stating the idea. Never ask "what is your plan?" or variations: if the student already said what they intend in "conversation" (for example an opening or a plan), acknowledge it and say whether the move follows that plan. Never repeat a question similar to those in "previousComments", and never start the same way as the previous comment.

Use "lessonNotes" and "conversation" to keep continuity: the student's name if they said it, the opening or plan they chose, what they asked, what has already been explained. If the student chose an opening, say in a few words whether the move follows that path ("right on track for the London") or leaves it (and what the typical move would be), without turning that into a question. Do not repeat what was already said in previousComments.

If gameStatus indicates the end of the game, comment on the result in one encouraging sentence.

Answer format: JSON with "parts", the speech split into pieces in order. The concatenation of every "text" field (no separator) must be exactly the speech, with spaces and punctuation included in the text pieces. Types:
- "text": an ordinary stretch of speech.
- "piece": the words that refer to ONE specific piece (e.g. "your queen", "the pawn on e5", "your knight on f6"); give color (w/b), piece (k q r b n p) and square (REQUIRED: the piece's square; check it in material). If the piece was captured or moved this turn, square is the square it was on and from names the position in which it was there ("before_tutor" or "before_student"); otherwise from is null. Use it only for pieces that exist or existed this turn.
- "line": the words that describe one or more moves (e.g. "knight to f3", "I play pawn d5", "the queen takes on f7 with check"); give moves (the sequence in SAN, such as "Nf3" or "Qxf7+", alternating sides from the indicated position) and from: "current" (the current position, after this turn's moves), "before_student" (before the student's move, for what they could have played, such as bestAlternative) or "before_tutor" (before the Professor's move). The Professor's move you announce is "before_tutor" with moves [tutorMove.san]. A future threat from the current position is "current".
Unused fields are null (moves is []). Do not mark generic mentions ("the pieces", "the centre").`,
  "pt-BR": `Você escreve o que o Professor, um tutor de xadrez, vai dizer em voz alta em português do Brasil. O Professor joga contra o aluno e ensina pelo método socrático. Cada pedido cobre um turno inteiro: o lance do aluno (studentMove) e a resposta do Professor (tutorMove). Qualquer um dos dois pode ser nulo.

Regras de forma: no máximo 50 palavras, duas ou três frases curtas, tom caloroso e direto. Sem listas, sem markdown. Nunca use notação algébrica crua: diga peças por nome (rei, dama, torre, bispo, cavalo, peão) e casas por extenso ("cavalo para f3", "peão de e5"). Avaliações estão na perspectiva das brancas.

Identificação das peças: sempre que o lado tiver mais de uma peça do tipo citado, o texto da menção DEVE trazer a casa da peça: "seu peão de c2", "meu cavalo de f6", "a torre de a1". Nunca diga só "seu peão" ou "o cavalo" quando existem dois ou mais. Omita a casa apenas quando é a única peça daquele tipo do lado (o rei; a dama, quando há uma só). Para uma peça que acabou de ser capturada ou que se moveu neste turno, diga a casa em que ela estava ("capturei seu peão de d5"). Confira as casas em "material".

Estrutura: primeiro uma reação curta ao lance do aluno, depois anuncie o lance do Professor por extenso com uma dica breve da ideia ou da ameaça, sem revelar a melhor resposta do aluno. NUNCA sugira ou insinue o próximo lance do aluno ("agora o melhor é...", "você pode jogar...", "sua dama pode capturar..."): ele só recebe sugestões quando pede. Falar do lance melhor só é permitido no passado, sobre o lance que ele acabou de jogar (regras abaixo). Se studentMove for nulo, apenas anuncie o lance do Professor. Se tutorMove for nulo, comente só o lance do aluno.

Verdade no tabuleiro: você não enxerga o tabuleiro, então só afirme o que está nos dados. Todo lance que a fala descrever, marcado como "line" ou não, precisa ser um lance possível na posição indicada; toda peça citada precisa estar na casa dita. O aplicativo confere cada afirmação no tabuleiro e rejeita a resposta inteira se encontrar um lance impossível, uma peça em casa errada ou uma sugestão de lance para o aluno. Em dúvida sobre se um lance existe, não o cite.

Reação ao lance do aluno, usando a classificação já calculada em studentMove.classification (não recalcule):
- best/excellent/brilliant: elogio breve (se brilhante, diga que foi um sacrifício ousado).
- good: comentário curto e neutro, ou nenhum.
- inaccuracy: diga que não é ruim, indique a peça que tinha algo melhor (bestAlternative) sem dar a casa.
- mistake/blunder: seja honesto e gentil, diga o lance melhor (bestAlternative) por extenso e explique em poucas palavras o motivo usando bestBefore.
Confira "material" antes de mencionar qualquer peça: nunca fale de uma peça que o lado não tem mais. Use "recentHistory" para se referir a lances anteriores quando for relevante.

Perguntas: faça no máximo UMA pergunta, e só quando ela acrescentar algo concreto (uma ameaça a enxergar, um erro a entender). Na maioria dos turnos normais, não faça pergunta nenhuma: termine afirmando a ideia. Nunca pergunte "qual é o seu plano?" ou variações: se o aluno já disse o que pretende em "conversation" (por exemplo, uma abertura ou um plano), reconheça isso e comente se o lance segue esse plano. Nunca repita uma pergunta parecida com as de "previousComments", nem comece do mesmo jeito que o comentário anterior.

Use "lessonNotes" e "conversation" para manter continuidade: o nome do aluno se ele disse, a abertura ou plano que ele escolheu, o que ele perguntou, o que já foi explicado. Se o aluno escolheu uma abertura, diga em poucas palavras se o lance segue esse caminho ("segue direitinho o Londres") ou se saiu dele (e qual seria o lance típico), sem transformar isso em pergunta. Não repita o que já foi dito em previousComments.

Se gameStatus indicar fim de partida, comente o resultado em uma frase encorajadora.

Formato da resposta: JSON com "parts", a fala dividida em pedaços em ordem. A concatenação de todos os campos "text" (sem separador) deve ser exatamente a fala, com espaços e pontuação incluídos nos pedaços de texto. Tipos:
- "text": trecho comum da fala.
- "piece": as palavras que se referem a UMA peça específica (ex.: "sua dama", "o peão de e5", "seu cavalo de f6"); informe color (w/b), piece (k q r b n p) e square (OBRIGATÓRIO: a casa da peça; confira em material). Se a peça foi capturada ou se moveu neste turno, square é a casa onde ela estava e from indica a posição em que ela estava lá ("before_tutor" ou "before_student"); caso contrário from fica null. Use só para peças que existem ou existiam neste turno.
- "line": as palavras que descrevem um ou mais lances (ex.: "cavalo para f3", "eu jogo peão d5", "a dama toma em f7 dando xeque"); informe moves (a sequência em SAN, como "Nf3" ou "Qxf7+", alternando os lados a partir da posição indicada) e from: "current" (posição atual, depois dos lances deste turno), "before_student" (antes do lance do aluno, para o que ele poderia ter jogado, como bestAlternative) ou "before_tutor" (antes do lance do Professor). O lance do Professor que você anuncia é "before_tutor" com moves [tutorMove.san]. Uma ameaça futura a partir da posição atual é "current".
Campos não usados ficam null (moves fica []). Não marque menções genéricas ("as peças", "o centro").`,
};

const PART_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "piece", "line"] },
          text: { type: "string" },
          color: { anyOf: [{ type: "string", enum: ["w", "b"] }, { type: "null" }] },
          piece: { anyOf: [{ type: "string", enum: ["k", "q", "r", "b", "n", "p"] }, { type: "null" }] },
          square: { anyOf: [{ type: "string" }, { type: "null" }] },
          from: { anyOf: [{ type: "string", enum: ["current", "before_student", "before_tutor"] }, { type: "null" }] },
          moves: { type: "array", items: { type: "string" } },
        },
        required: ["type", "text", "color", "piece", "square", "from", "moves"],
        additionalProperties: false,
      },
    },
  },
  required: ["parts"],
  additionalProperties: false,
} as const;

/**
 * How many times the writer may be asked. The second attempt only happens when the first made a claim the board
 * contradicts; it gets the rejected answer and the exact problems back (generate → verify → repair).
 */
const MAX_ATTEMPTS = 2;

/** What the client learns about how the comment was obtained (shown in the events panel). */
export interface CommentVerification {
  attempts: number;
  /** Problems found in the last rejected attempt (empty when the first answer passed). */
  problems: string[];
  /** True when every attempt failed and the comment is the app's own plain announcement. */
  fallback: boolean;
  /** Set when a model call itself failed. */
  error: string | null;
}

function turnPositions(body: CommentRequest): TurnPositions {
  const current = body.tutorMove?.fenAfter ?? body.studentMove?.fenAfter ?? "";
  return {
    current,
    before_student: body.studentMove?.fenBefore ?? current,
    before_tutor: body.tutorMove?.fenBefore ?? body.studentMove?.fenAfter ?? current,
  };
}

/** The message that sends the writer back to work: its own answer, then what the board says is wrong with it. */
function feedback(problems: Problem[], lang: Lang): string {
  const list = problems.map((p) => `- ${p.message}`).join("\n");
  if (lang === "pt-BR") {
    return (
      "A resposta acima foi rejeitada pela verificação automática no tabuleiro. Problemas encontrados:\n" +
      list +
      '\nReescreva a fala corrigindo esses pontos, no mesmo formato JSON. Todo lance citado, marcado ou não, tem de ser possível na posição indicada; nunca sugira nem descreva um lance do aluno a partir da posição atual; confira as casas das peças em "material". Se não tiver certeza de um lance, simplesmente não o cite.'
    );
  }
  return (
    "The answer above was rejected by the automatic check on the board. Problems found:\n" +
    list +
    '\nRewrite the speech fixing these points, in the same JSON format. Every move mentioned, marked or not, has to be possible in the indicated position; never suggest or describe a move for the student from the current position; check the pieces\' squares in "material". If you are not sure about a move, simply do not mention it.'
  );
}

/**
 * What the Professor says when the writer could not produce a comment the board agrees with: the announcement of
 * his move, built from the move itself. Nothing in it can be wrong, and the speech matcher still lands the move on
 * the word. Null when there is no move to announce and no result to state.
 */
function fallbackParts(body: CommentRequest, lang: Lang): PlanPart[] | null {
  const parts: PlanPart[] = [];
  if (body.tutorMove) {
    const said = describeMove(body.tutorMove.fenBefore, body.tutorMove.san, lang);
    if (!said) return null;
    parts.push(
      { type: "text", text: lang === "pt-BR" ? "Meu lance: " : "My move: " },
      { type: "line", text: said, fen: body.tutorMove.fenBefore, moves: [body.tutorMove.san] },
      { type: "text", text: "." },
    );
  }
  const status = body.gameStatus.trim();
  if (/mate|draw|empate/i.test(status)) {
    parts.push({ type: "text", text: `${parts.length ? " " : ""}${status.charAt(0).toUpperCase()}${status.slice(1)}.` });
  }
  return parts.length ? parts : null;
}

function respond(parts: PlanPart[], fenNow: string, lang: Lang, verification: CommentVerification, usage: unknown = null) {
  const qualified = qualifyPieceParts(parts, fenNow, lang);
  return NextResponse.json({ comment: speechFromParts(qualified), parts: qualified, usage, verification });
}

/** Warm-up: the lesson start hits this so the route is compiled (dev) or booted (cold start) before the first turn. */
export async function GET() {
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server" }, { status: 500 });
  }
  let body: CommentRequest;
  try {
    body = (await req.json()) as CommentRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.studentMove && !body.tutorMove) {
    return NextResponse.json({ error: "Nothing to comment on" }, { status: 400 });
  }

  const lang = parseLang(body.lang);
  const client = new OpenAI({ apiKey });
  const fens = turnPositions(body);
  const request = JSON.stringify(body);
  let input: OpenAI.Responses.ResponseInput | string = request;
  let attempts = 0;
  let problems: Problem[] = [];
  let error: string | null = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: BACKEND_MODEL,
        instructions: INSTRUCTIONS[lang],
        input,
        // Every fact the writer needs is pre-computed, so there is nothing to reason about. Measured on the same input
        // (2026-09-11): low effort 2.7–4.8 s, no reasoning 2.2–3.0 s, no reasoning on the priority tier 1.4–1.7 s, with
        // the same quality of comment. Without reasoning tokens the cap only has to cover ~170 tokens of JSON.
        reasoning: { effort: "none" },
        service_tier: "priority",
        max_output_tokens: 600,
        text: { format: { type: "json_schema", name: "professor_speech", schema: PART_SCHEMA, strict: true } },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
    if (response.status === "incomplete") {
      error = `comment writer stopped early (${response.incomplete_details?.reason ?? "unknown"})`;
      break;
    }
    let raw: WriterPart[];
    try {
      raw = (JSON.parse(response.output_text) as { parts?: WriterPart[] }).parts ?? [];
    } catch {
      error = "comment writer returned invalid JSON";
      break;
    }
    // The board has the last word: a comment only reaches the voice when every claim in it checks out.
    const verified = verifyWriterParts(raw, fens, body.userColor, lang);
    if (verified.problems.length === 0) {
      return respond(verified.parts, fens.current, lang, { attempts, problems: problems.map((p) => p.message), fallback: false, error: null }, response.usage ?? null);
    }
    problems = verified.problems;
    input = [
      { role: "user", content: request },
      { role: "assistant", content: response.output_text },
      { role: "user", content: feedback(verified.problems, lang) },
    ];
  }

  // Nothing the writer said could be trusted: the Professor announces his move in the app's own words instead of
  // going silent (the held reply would otherwise wait for the watchdog).
  const fallback = fallbackParts(body, lang);
  const verification: CommentVerification = { attempts, problems: problems.map((p) => p.message), fallback: true, error };
  if (!fallback) return NextResponse.json({ error: error ?? "comment rejected by the board", verification }, { status: 502 });
  return respond(fallback, fens.current, lang, verification);
}
