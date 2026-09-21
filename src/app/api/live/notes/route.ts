import OpenAI from "openai";
import { NextResponse } from "next/server";
import { BACKEND_MODEL } from "@/lib/live/session-config";
import { parseLang, type Lang } from "@/lib/i18n/lang";

export const runtime = "nodejs";

/**
 * Lesson notes are the application's own memory about the student (name, chosen
 * opening, declared plans, preferences). They are updated from each student utterance
 * and injected into every channel the tutor uses, so they survive session forks,
 * context compaction and the stateless comment writer.
 */
export interface NotesRequest {
  /** Language the notes are written in. */
  lang: Lang;
  /** Current notes (may be empty). */
  notes: string;
  /** What the student just said (transcript). */
  utterance: string;
  /** What the Professor said right before, for context (may be null). */
  professorBefore: string | null;
}

const NO_CHANGE: Record<Lang, string> = { en: "NO CHANGE", "pt-BR": "SEM MUDANÇA" };

const INSTRUCTIONS: Record<Lang, string> = {
  en: `You maintain the "lesson notes": the TEACHess app's memory about the chess student. You receive the current notes, the student's latest utterance (a voice transcript, it may contain errors) and, for context, what the Professor said before it.

Update the notes only with lasting facts that are useful for teaching: the student's name, the opening or system they want to play (for example "wants to play the London System as White"), declared plans or goals ("I want to practise endgames", "I want to attack on the kingside"), level or experience, preferences about the lesson (pace, whether they want hints, whether they want direct answers). If the student changes their mind, replace the old fact. Ignore one-off questions about the position, remarks about a move and small talk.

Format: short sentences in English, no markdown, at most 400 characters. Answer only with the complete updated notes. If nothing needs to change, answer exactly: ${NO_CHANGE.en}`,
  "pt-BR": `Você mantém as "notas da aula": a memória do aplicativo TEACHess sobre o aluno de xadrez. Você recebe as notas atuais, a última fala do aluno (transcrição de voz, pode ter erros) e, para contexto, a fala anterior do Professor.

Atualize as notas somente com fatos duradouros e úteis para ensinar: nome do aluno, abertura ou sistema que ele quer jogar (por exemplo "quer jogar o Sistema Londres com as brancas"), planos ou objetivos declarados ("quero treinar finais", "quero atacar no flanco do rei"), nível ou experiência, preferências sobre a aula (ritmo, quer ou não dicas, quer respostas diretas). Se o aluno mudar de ideia, substitua o fato antigo. Ignore perguntas pontuais sobre a posição, comentários sobre um lance e conversa fiada.

Formato: frases curtas em português do Brasil, sem markdown, no máximo 400 caracteres. Responda apenas com as notas completas atualizadas. Se nada precisar mudar, responda exatamente: ${NO_CHANGE["pt-BR"]}`,
};

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server" }, { status: 500 });
  }
  let body: NotesRequest;
  try {
    body = (await req.json()) as NotesRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.utterance?.trim()) return NextResponse.json({ notes: body.notes ?? "", changed: false });

  const lang = parseLang(body.lang);
  const client = new OpenAI({ apiKey });
  try {
    const response = await client.responses.create({
      model: BACKEND_MODEL,
      instructions: INSTRUCTIONS[lang],
      input: JSON.stringify({ notes: body.notes ?? "", utterance: body.utterance, professorBefore: body.professorBefore }),
      reasoning: { effort: "none" }, // an extraction task: no reasoning tokens, so the cap only covers the notes
      service_tier: "priority",
      max_output_tokens: 800,
    });
    const text = response.output_text.trim();
    if (!text || text.toUpperCase().startsWith(NO_CHANGE[lang])) {
      return NextResponse.json({ notes: body.notes ?? "", changed: false });
    }
    return NextResponse.json({ notes: text.slice(0, 600), changed: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
