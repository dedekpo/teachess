import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import { MAX_PIECE_CANDIDATES, flipTurn, moveCandidates, moveMention, pieceMention, resolvePiece, squareMention, tryMove } from "./resolve";
import type { Mention, Plan } from "./types";
import type { Lang } from "@/lib/i18n/lang";

/**
 * Spoken chess talk → phrases ("knight from f3 to a4", "your queen", "e5"; in Portuguese "cavalo de f3 para a4",
 * "sua dama"). Works on transcripts and on the backend's prose. Character ranges refer to the original text.
 * The vocabulary is per language (`LEXICONS`); the parsing rules are shared.
 */

export type PersonHint = "first" | "second" | "third" | "white" | "black";

export interface Phrase {
  start: number;
  end: number;
  text: string;
  piece: PieceSymbol | null;
  side: PersonHint | null;
  /** Square the piece is on ("knight on f3"); `implicitAt` when no preposition was said ("knight f3"). */
  at: Square | null;
  implicitAt: boolean;
  /** Destination ("to a4"). */
  to: Square | null;
  /** "takes / captures" + what. */
  capture: { piece: PieceSymbol | null; square: Square | null } | null;
  /** False when the phrase touches the end of the text and more words could still extend it. */
  complete: boolean;
}

/** The words of one language, after `fold` (lower case, no accents). */
export interface Lexicon {
  pieceWords: Record<string, PieceSymbol>;
  numberWords: Record<string, string>;
  /** Prepositions that introduce where a piece stands ("knight on f3", "the rook from a1"). */
  atPreps: Set<string>;
  /** Prepositions that introduce a destination ("knight to f3"). */
  toPreps: Set<string>;
  captureWords: Set<string>;
  sideWords: Record<string, PersonHint>;
  /** Verbs that may sit between a piece and where it goes ("his bishop comes to b4"). */
  moveVerbs: Set<string>;
  checkWords: Set<string>;
  filler: Set<string>;
  /** Adverbs that sit between a piece and what it does ("your queen now can capture on c4") without ending the phrase. */
  adverbs: Set<string>;
  /** The location preposition that also introduces a destination once a location is known ("on"/"em"). */
  onPrep: string;
}

export const LEXICONS: Record<Lang, Lexicon> = {
  en: {
    pieceWords: {
      king: "k", kings: "k",
      queen: "q", queens: "q",
      rook: "r", rooks: "r",
      bishop: "b", bishops: "b",
      knight: "n", knights: "n", horse: "n", horsey: "n",
      pawn: "p", pawns: "p",
    },
    numberWords: { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8" },
    atPreps: new Set(["on", "at", "from", "in"]),
    toPreps: new Set(["to", "toward", "towards", "into", "onto"]),
    captureWords: new Set(["take", "takes", "taking", "took", "taken", "capture", "captures", "capturing", "captured", "grab", "grabs", "grabbing", "grabbed", "win", "wins", "winning", "won"]),
    sideWords: {
      my: "first", mine: "first", i: "first", me: "first",
      your: "second", yours: "second", you: "second",
      his: "third", her: "third", hers: "third", their: "third", theirs: "third", he: "third", she: "third", they: "third", opponent: "third", opponents: "third", enemy: "third", rival: "third",
      white: "white", whites: "white",
      black: "black", blacks: "black",
    },
    moveVerbs: new Set(["go", "goes", "going", "went", "gone", "come", "comes", "coming", "came", "move", "moves", "moving", "moved", "play", "plays", "playing", "played", "jump", "jumps", "jumping", "jumped", "hop", "hops", "hopping", "hopped", "land", "lands", "landing", "landed", "drop", "drops", "dropping", "dropped", "retreat", "retreats", "retreating", "retreated", "advance", "advances", "advancing", "advanced", "push", "pushes", "pushing", "pushed", "slide", "slides", "sliding", "slid", "swing", "swings", "swinging", "swung", "develop", "develops", "developing", "developed", "put", "puts", "putting", "bring", "brings", "bringing", "brought", "get", "gets", "getting", "got", "head", "heads", "heading", "headed", "step", "steps", "stepping", "stepped", "back", "can", "could", "should", "would", "may", "might", "will", "must", "want", "wants", "wanted", "let", "lets", "like", "likes", "try", "tries", "give", "gives", "giving", "gave", "deliver", "delivers", "delivering", "delivered", "be", "is", "are", "was", "were", "been", "being", "do", "does", "did", "have", "has", "had"]),
    checkWords: new Set(["check", "checks", "checking", "mate", "checkmate", "checkmates", "mates"]),
    filler: new Set(["the", "a", "an", "this", "that", "these", "those", "and", "with", "by", "of", "it", "there", "here", "up", "down", "over", "out", "away", "right", "also", "again"]),
    adverbs: new Set(["now", "still", "also", "then", "just", "only", "first", "simply", "immediately", "safely", "easily", "already", "next", "later", "again", "straight", "even", "really", "actually", "probably", "maybe", "perhaps", "definitely"]),
    onPrep: "on",
  },
  "pt-BR": {
    pieceWords: {
      rei: "k", reis: "k",
      dama: "q", damas: "q", rainha: "q", rainhas: "q",
      torre: "r", torres: "r",
      bispo: "b", bispos: "b",
      cavalo: "n", cavalos: "n", cavalinho: "n",
      peao: "p", peoes: "p", peaozinho: "p",
    },
    numberWords: { um: "1", dois: "2", tres: "3", quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8" },
    atPreps: new Set(["de", "do", "da", "em", "no", "na", "la"]),
    toPreps: new Set(["para", "pra", "ate", "rumo"]),
    captureWords: new Set(["toma", "tomar", "tomando", "tomou", "captura", "capturar", "capturando", "capturou", "come", "comer", "comendo", "comeu", "pega", "pegar", "pegando", "pegou"]),
    sideWords: {
      meu: "first", minha: "first", meus: "first", minhas: "first", eu: "first",
      seu: "second", sua: "second", seus: "second", suas: "second", teu: "second", tua: "second", voce: "second", voces: "second",
      dele: "third", dela: "third", ele: "third", adversario: "third", oponente: "third", inimigo: "third", rival: "third",
      brancas: "white", branca: "white", branco: "white", brancos: "white",
      pretas: "black", preta: "black", preto: "black", pretos: "black", negras: "black",
    },
    moveVerbs: new Set(["dar", "da", "dando", "deu", "faz", "fazer", "fazendo", "vai", "vem", "vao", "ir", "indo", "joga", "jogar", "jogando", "pula", "salta", "volta", "avanca", "recua", "entra", "chega", "segue", "corre", "desce", "sobe", "move", "mover", "movendo", "leva", "levar", "levando", "coloca", "colocar", "bota", "botar", "pode", "poderia", "deve", "deveria", "vou", "quer", "pular", "saltar", "voltar", "avancar", "recuar", "entrar"]),
    checkWords: new Set(["xeque", "cheque", "check", "mate", "xequemate"]),
    filler: new Set(["o", "a", "os", "as", "um", "uma", "esse", "essa", "este", "esta", "aquele", "aquela", "que", "e", "com", "por"]),
    adverbs: new Set(["agora", "ainda", "tambem", "depois", "ja", "entao", "logo", "so", "apenas", "primeiro", "mesmo", "simplesmente", "imediatamente", "tranquilamente", "facilmente"]),
    onPrep: "em",
  },
};

const ACCENTS: Record<string, string> = {
  á: "a", à: "a", â: "a", ã: "a", ä: "a", é: "e", ê: "e", è: "e", í: "i", ì: "i", ó: "o", ô: "o", õ: "o", ò: "o", ú: "u", ù: "u", ü: "u", ç: "c",
};

/** Lower-cases and strips accents without changing string length. */
export function fold(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) out += ACCENTS[ch] ?? ch;
  return out;
}

interface Tok {
  w: string;
  start: number;
  end: number;
}

function tokenize(folded: string): Tok[] {
  const out: Tok[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded))) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** True when punctuation separates two tokens (phrases never cross it). */
function punctuated(folded: string, a: Tok, b: Tok): boolean {
  return /[.,;:!?()]/.test(folded.slice(a.end, b.start));
}

/** Reads a square starting at token i; returns the square and the index of the last token used. */
function squareAtIn(toks: Tok[], i: number, allowSpaced: boolean, numberWords: Record<string, string>): { sq: Square; last: number } | null {
  const t = toks[i];
  if (!t) return null;
  if (/^[a-h][1-8]$/.test(t.w)) return { sq: t.w as Square, last: i };
  if (!allowSpaced || !/^[a-h]$/.test(t.w)) return null;
  const n = toks[i + 1];
  if (!n || toks[i].end + 1 < n.start) return null;
  const digit = /^[1-8]$/.test(n.w) ? n.w : numberWords[n.w];
  if (!digit) return null;
  return { sq: `${t.w}${digit}` as Square, last: i + 1 };
}

export function parsePhrases(text: string, lang: Lang): Phrase[] {
  const { pieceWords: PIECE_WORDS, atPreps: AT_PREPS, toPreps: TO_PREPS, captureWords: CAPTURE_WORDS, sideWords: SIDE_WORDS, moveVerbs: MOVE_VERBS, checkWords: CHECK_WORDS, filler: FILLER, adverbs: ADVERBS, numberWords, onPrep } = LEXICONS[lang];
  const squareAt = (t: Tok[], i: number, allowSpaced: boolean) => squareAtIn(t, i, allowSpaced, numberWords);
  const folded = fold(text);
  const toks = tokenize(folded);
  const phrases: Phrase[] = [];
  const used = new Set<number>();
  const growable = (w: string) =>
    AT_PREPS.has(w) || TO_PREPS.has(w) || CAPTURE_WORDS.has(w) || FILLER.has(w) || MOVE_VERBS.has(w) || CHECK_WORDS.has(w) || ADVERBS.has(w) || w in SIDE_WORDS;

  const finish = (p: Omit<Phrase, "complete" | "text">, lastTok: number) => {
    const rest = toks.slice(lastTok + 1).map((t) => t.w);
    const complete = folded.slice(p.end).trim() !== "" && !(rest.every(growable) && !/[.,;:!?]/.test(folded.slice(p.end)));
    phrases.push({ ...p, text: text.slice(p.start, p.end), complete });
  };

  for (let i = 0; i < toks.length; i++) {
    if (used.has(i)) continue;
    const t = toks[i];
    const piece = PIECE_WORDS[t.w];
    if (piece) {
      let side: PersonHint | null = null;
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        const h = SIDE_WORDS[toks[k].w];
        if (h) {
          side = h;
          break;
        }
        if (!FILLER.has(toks[k].w)) break;
      }
      const p: Omit<Phrase, "complete" | "text"> = { start: t.start, end: t.end, piece, side, at: null, implicitAt: false, to: null, capture: null };
      let last = i;
      let j = i + 1;
      let steps = 0;
      let sawCheck = false; // "gives check on a5": the square after the check word is a destination
      while (j < toks.length && steps < 7 && !punctuated(folded, toks[j - 1], toks[j])) {
        const w = toks[j].w;
        if (AT_PREPS.has(w) || TO_PREPS.has(w)) {
          const sq = squareAt(toks, j + 1, true);
          if (sq && !punctuated(folded, toks[j], toks[j + 1])) {
            if (p.capture && !p.capture.square && !p.to) {
              // "takes on e5", "captures on c4": the square after the capture word is where the capture happens.
              p.capture.square = sq.sq;
            } else if (TO_PREPS.has(w) || (w === onPrep && p.at) || p.to || sawCheck) {
              if (!p.to) p.to = sq.sq;
            } else if (!p.at) p.at = sq.sq;
            else if (!p.to) p.to = sq.sq;
            last = sq.last;
            j = sq.last + 1;
            steps++;
            continue;
          }
          if (TO_PREPS.has(w) || AT_PREPS.has(w)) {
            // "to" followed by something else ("wants to take"): keep scanning one more token.
            j++;
            steps++;
            continue;
          }
        }
        if (CAPTURE_WORDS.has(w)) {
          let k = j + 1;
          while (k < toks.length && (FILLER.has(toks[k].w) || toks[k].w in SIDE_WORDS)) k++;
          const tp = toks[k] ? PIECE_WORDS[toks[k].w] : undefined;
          const sq = squareAt(toks, k, true);
          if (tp) {
            p.capture = { piece: tp, square: null };
            const sq2 = squareAt(toks, k + 1, true) ?? (AT_PREPS.has(toks[k + 1]?.w ?? "") ? squareAt(toks, k + 2, true) : null);
            if (sq2) {
              p.capture.square = sq2.sq;
              k = sq2.last;
            }
            for (let u = j; u <= k; u++) used.add(u);
            last = k;
            j = k + 1;
          } else if (sq) {
            p.capture = { piece: null, square: sq.sq };
            for (let u = j; u <= sq.last; u++) used.add(u);
            last = sq.last;
            j = sq.last + 1;
          } else {
            p.capture = { piece: null, square: null };
            last = j;
            j++;
          }
          steps++;
          continue;
        }
        const direct = squareAt(toks, j, false);
        if (direct && !p.at && !p.to && j === i + 1) {
          p.at = direct.sq;
          p.implicitAt = true;
          last = direct.last;
          j = direct.last + 1;
          steps++;
          continue;
        }
        if (CHECK_WORDS.has(w)) {
          sawCheck = true;
          j++;
          steps++;
          continue;
        }
        if (FILLER.has(w) || w in SIDE_WORDS || MOVE_VERBS.has(w) || ADVERBS.has(w)) {
          j++;
          steps++;
          continue;
        }
        break;
      }
      for (let u = i; u <= last; u++) used.add(u);
      p.end = toks[last].end;
      finish(p, last);
      i = last;
      continue;
    }
    const prev = toks[i - 1];
    const spacedOk = !!prev && (AT_PREPS.has(prev.w) || TO_PREPS.has(prev.w) || CAPTURE_WORDS.has(prev.w));
    const sq = squareAt(toks, i, spacedOk);
    if (sq) {
      const capture = !!prev && CAPTURE_WORDS.has(prev.w);
      for (let u = i; u <= sq.last; u++) used.add(u);
      finish({ start: t.start, end: toks[sq.last].end, piece: null, side: null, at: sq.sq, implicitAt: false, to: null, capture: capture ? { piece: null, square: sq.sq } : null }, sq.last);
      i = sq.last;
    }
  }
  return phrases;
}

/** Whose pieces a possessive refers to ("my", "your", "his"). "Third person" is the student's opponent, i.e. the Professor. */
export function hintColor(hint: PersonHint | null, speaker: "student" | "professor", userColor: Color): Color | null {
  const tutor: Color = userColor === "w" ? "b" : "w";
  switch (hint) {
    case "white":
      return "w";
    case "black":
      return "b";
    case "first":
      return speaker === "student" ? userColor : tutor;
    case "second":
      return speaker === "student" ? tutor : userColor;
    case "third":
      return tutor;
    default:
      return null;
  }
}

export interface ResolveContext {
  /** Language of the text being resolved. */
  lang: Lang;
  speaker: "student" | "professor";
  userColor: Color;
  /** Destinations of the last moves, most recent first (tie-breaker for "the knight"). */
  recentSquares: Square[];
  /**
   * Positions before the last moves, most recent first. Speech is often about what just happened ("your bishop from f4
   * took on e5"): a piece named on a square it has just left is resolved in the position where it still stood.
   */
  recentFens?: string[];
}

function pieceOn(fen: string, square: Square, piece: PieceSymbol): boolean {
  try {
    return new Chess(fen).get(square)?.type === piece;
  } catch {
    return false;
  }
}

/**
 * Resolves one phrase against a position, with no plan to help. Returns the mention and the position after it
 * (moves advance the position so a spoken sequence can be followed).
 */
export function resolvePhrase(id: string, phrase: Phrase, fen: string, ctx: ResolveContext): { mention: Mention; fenAfter: string } | null {
  if (phrase.piece && phrase.at && !pieceOn(fen, phrase.at, phrase.piece)) {
    const { at, piece } = phrase;
    const past = (ctx.recentFens ?? []).find((f) => pieceOn(f, at, piece));
    if (past) {
      const r = resolveIn(id, phrase, past, ctx);
      if (r) return r;
    }
  }
  return resolveIn(id, phrase, fen, ctx);
}

/**
 * The resolution proper, in one position. Its contract: a mention is only ever the piece or move the phrase actually
 * describes. When the described move is not possible the phrase resolves to the piece or the square it talked about
 * (or to nothing), never to some other move the piece could make.
 */
function resolveIn(id: string, phrase: Phrase, fen: string, ctx: ResolveContext): { mention: Mention; fenAfter: string } | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const color = hintColor(phrase.side, ctx.speaker, ctx.userColor);
  const text = phrase.text;
  /** The origin the phrase names, when that piece really stands there. */
  const origin = phrase.at && chess.get(phrase.at)?.type === phrase.piece ? phrase.at : null;

  const asMove = (piece: PieceSymbol | null, to: Square, from: Square | null): { mention: Mention; fenAfter: string } | null => {
    const res = tryMove(fen, { piece, to, from }, true);
    if (res && (!color || res.move.color === color || from)) {
      return { mention: moveMention(id, res.move, res.fenBefore, text, null), fenAfter: res.move.after };
    }
    if (!piece) return null;
    const cands = moveCandidates(fen, piece, to, true);
    if (!cands) return null;
    const m = pieceMention(id, fen, cands.color, piece, cands.from, text);
    m.visual.arrows = cands.from.map((f) => ({ from: f, to, kind: "move" as const }));
    return { mention: m, fenAfter: fen };
  };

  /** The piece the phrase is about, when it can be pinned down; `extra` squares are shown with it. */
  const asPiece = (piece: PieceSymbol, extra: Square[]): { mention: Mention; fenAfter: string } | null => {
    if (origin) {
      const on = chess.get(origin)!;
      if (!color || on.color === color) {
        const m = pieceMention(id, fen, on.color, piece, [origin], text);
        m.visual.squares = [origin, ...extra];
        return { mention: m, fenAfter: fen };
      }
    }
    const colors: Color[] = color ? [color] : ["w", "b"];
    let squares: Square[] = [];
    let found: Color | null = null;
    for (const c of colors) {
      const s = resolvePiece(fen, c, piece, null);
      if (s.length && (!found || s.length < squares.length)) {
        squares = s;
        found = c;
      }
      if (color) break;
    }
    if (!found || squares.length === 0) return null;
    if (squares.length > 1) {
      const recent = ctx.recentSquares.find((sq) => squares.includes(sq));
      if (recent) squares = [recent];
    }
    if (squares.length > MAX_PIECE_CANDIDATES) return null;
    const m = pieceMention(id, fen, found, piece, squares, text);
    m.visual.squares = [...squares, ...extra];
    return { mention: m, fenAfter: fen };
  };

  if (phrase.piece && phrase.to) {
    const mv = asMove(phrase.piece, phrase.to, origin);
    // "your queen to c4" when the queen cannot get there: show the queen and the square, not another queen move.
    return mv ?? asPiece(phrase.piece, [phrase.to]) ?? { mention: squareMention(id, fen, phrase.to, text), fenAfter: fen };
  }
  if (phrase.piece && phrase.capture) {
    const target = phrase.capture;
    const matches = (f: string) => {
      try {
        return new Chess(f)
          .moves({ verbose: true })
          .filter(
            (m) =>
              m.piece === phrase.piece &&
              m.captured &&
              (!origin || m.from === origin) &&
              (!target.square || m.to === target.square) &&
              (!target.piece || m.captured === target.piece) &&
              (!color || m.color === color),
          );
      } catch {
        return [];
      }
    };
    let found = matches(fen);
    let base = fen;
    if (found.length === 0) {
      const flipped = flipTurn(fen);
      if (flipped) {
        found = matches(flipped);
        base = flipped;
      }
    }
    const distinct = new Map(found.map((m) => [`${m.from}${m.to}`, m]));
    if (distinct.size === 1) {
      const mv = [...distinct.values()][0];
      const res = tryMove(base, { piece: mv.piece, to: mv.to, from: mv.from }, false);
      if (res) return { mention: moveMention(id, res.move, res.fenBefore, text, null), fenAfter: res.move.after };
    }
    // Not a capture that exists: the piece and the square it was said to take on, so the student sees why not.
    const extra = target.square ? [target.square] : [];
    const piece = asPiece(phrase.piece, extra);
    if (piece) return piece;
    if (target.square) return { mention: squareMention(id, fen, target.square, text), fenAfter: fen };
    return null;
  }
  if (phrase.piece && phrase.at) {
    if (origin) {
      const on = chess.get(origin)!;
      if (!color || on.color === color) return { mention: pieceMention(id, fen, on.color, on.type, [origin], text), fenAfter: fen };
    }
    // No such piece there: "bishop on f4" / "knight f3" describe a move to that square.
    const mv = asMove(phrase.piece, phrase.at, null);
    if (mv) return mv;
  }
  if (phrase.piece) return asPiece(phrase.piece, []);
  if (phrase.at) {
    const on = chess.get(phrase.at);
    if (on) return { mention: pieceMention(id, fen, on.color, on.type, [phrase.at], text), fenAfter: fen };
    return { mention: squareMention(id, fen, phrase.at, text), fenAfter: fen };
  }
  return null;
}

/** Builds a plan from prose (the backend's answer) by resolving each phrase in order against the position. */
/**
 * Builds a plan from prose (the backend's answer). Prose mixes sequences ("Na4, then Qh5") with alternatives
 * ("Bb5, or the safer Be2"), so each phrase is resolved against the base position first and only falls back to the
 * position after the previous moves when it is not legal at the base.
 */
export function planFromProse(id: string, text: string, fen: string, ctx: ResolveContext): Plan {
  const steps: Mention[] = [];
  let cur = fen;
  const phrases = parsePhrases(text, ctx.lang);
  phrases.forEach((ph, i) => {
    const mid = `${id}:${i}`;
    let r = resolvePhrase(mid, ph, fen, ctx);
    if ((!r || r.mention.body.kind !== "move") && cur !== fen) {
      const seq = resolvePhrase(mid, ph, cur, ctx);
      if (seq && (seq.mention.body.kind === "move" || !r)) r = seq;
    }
    if (!r) return;
    steps.push(r.mention);
    if (r.mention.body.kind === "move") {
      r.mention.lineId = id;
      // Advance the working position only when the move is also playable there (a real continuation).
      const b = r.mention.body;
      const onCur = tryMove(cur, { piece: b.piece, to: b.to, from: b.from }, true);
      cur = onCur ? onCur.move.after : cur;
    }
  });
  return { id, fen, steps, createdAt: performance.now(), source: "backend" };
}
