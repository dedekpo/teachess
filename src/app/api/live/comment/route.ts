import OpenAI from "openai";
import { NextResponse } from "next/server";
import { BACKEND_MODEL } from "@/lib/live/session-config";

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
  classificationPt: string;
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
  userColor: "w" | "b";
  studentMove: MoveInfo | null;
  tutorMove: MoveInfo | null;
  /** Full move list so far, e.g. "1. e4 e5 2. Nf3 Nc6". */
  history: string;
  /** The last few moves annotated, oldest first. */
  recentHistory: string;
  /** Material currently on the board, in Portuguese, including which pieces each side no longer has. */
  material: string;
  gameStatus: string;
  /** Application memory about the student: name, chosen opening, declared plans, preferences. */
  lessonNotes: string;
  /** Recent spoken conversation (student and Professor), oldest first. */
  conversation: { role: "student" | "professor"; text: string }[];
  /** The last comments the Professor already said about earlier moves, oldest first. */
  previousComments: string[];
}

const INSTRUCTIONS = `Você escreve o que o Professor, um tutor de xadrez, vai dizer em voz alta em português do Brasil. O Professor joga contra o aluno e ensina pelo método socrático. Cada pedido cobre um turno inteiro: o lance do aluno (studentMove) e a resposta do Professor (tutorMove). Qualquer um dos dois pode ser nulo.

Regras de forma: no máximo 50 palavras, duas ou três frases curtas, tom caloroso e direto. Sem listas, sem markdown. Nunca use notação algébrica crua: diga peças por nome (rei, dama, torre, bispo, cavalo, peão) e casas por extenso ("cavalo para f3", "peão de e5"). Avaliações estão na perspectiva das brancas.

Estrutura: primeiro uma reação curta ao lance do aluno, depois anuncie o lance do Professor por extenso com uma dica breve da ideia ou da ameaça, sem revelar a melhor resposta do aluno. Se studentMove for nulo, apenas anuncie o lance do Professor. Se tutorMove for nulo, comente só o lance do aluno.

Reação ao lance do aluno, usando a classificação já calculada em studentMove.classification (não recalcule):
- best/excellent/brilliant: elogio breve (se brilhante, diga que foi um sacrifício ousado).
- good: comentário curto e neutro, ou nenhum.
- inaccuracy: diga que não é ruim, indique a peça que tinha algo melhor (bestAlternative) sem dar a casa.
- mistake/blunder: seja honesto e gentil, diga o lance melhor (bestAlternative) por extenso e explique em poucas palavras o motivo usando bestBefore.
Confira "material" antes de mencionar qualquer peça: nunca fale de uma peça que o lado não tem mais. Use "recentHistory" para se referir a lances anteriores quando for relevante.

Perguntas: faça no máximo UMA pergunta, e só quando ela acrescentar algo concreto (uma ameaça a enxergar, um erro a entender). Na maioria dos turnos normais, não faça pergunta nenhuma: termine afirmando a ideia. Nunca pergunte "qual é o seu plano?" ou variações: se o aluno já disse o que pretende em "conversation" (por exemplo, uma abertura ou um plano), reconheça isso e comente se o lance segue esse plano. Nunca repita uma pergunta parecida com as de "previousComments", nem comece do mesmo jeito que o comentário anterior.

Use "lessonNotes" e "conversation" para manter continuidade: o nome do aluno se ele disse, a abertura ou plano que ele escolheu, o que ele perguntou, o que já foi explicado. Se o aluno escolheu uma abertura, diga em poucas palavras se o lance segue esse caminho ("segue direitinho o Londres") ou se saiu dele (e qual seria o lance típico), sem transformar isso em pergunta. Não repita o que já foi dito em previousComments.

Se gameStatus indicar fim de partida, comente o resultado em uma frase encorajadora.

Responda apenas com o texto a ser falado.`;

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

  const client = new OpenAI({ apiKey });
  try {
    const response = await client.responses.create({
      model: BACKEND_MODEL,
      instructions: INSTRUCTIONS,
      input: JSON.stringify(body),
      max_output_tokens: 250,
    });
    const comment = response.output_text.trim();
    return NextResponse.json({ comment, usage: response.usage ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
