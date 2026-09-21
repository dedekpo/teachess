# TEACHess voice tutor — plan (GPT-Live)

Status: implemented 2026-09-11 (first version). Decisions taken with the user:
tutor plays the opponent (Stockfish at a chosen Elo), comments on every student move and announces its own,
backend `gpt-5.6-luna`, English by default (voice `cedar`) or Brazilian Portuguese with `?lang=pt-BR` (voice `tempo`), always-on session once a lesson starts,
idle close after 90 s (configurable) with fork-based resume on mic activity or a move.

Files: `src/lib/live/*` (client, prompts, tools, lesson helpers), `src/app/api/live/*` (session, fork, comment routes),
`src/lib/engine-player.ts` (opponent engine), `src/components/CoachPanel.tsx`, `src/components/LessonSetup.tsx`.

Verified without a microphone (silent track): greeting, per-move commentary, opponent reply + announcement,
idle close + fork resume. Still to verify with a real mic: speech recognition, delegation + tool calls, interruptions.

Update 2026-09-11 (repetition + stale speech):
- One spoken comment per **turn** (student move + Professor reply) instead of two, written by `/api/live/comment`
  which now receives the recent transcript and the last comments, and is told to ask at most one question and only
  when it adds something (never "what's your plan?" once the student stated one).
- Stale comments are dropped: the turn comment is discarded if the board changed while analysis/writing ran.
- Programmatic interruption: the Live API has no cancel event (client events are start/update/input_audio.*/
  *.append/response.*/close). `LiveTutorClient.stop()` follows OpenAI's documented pattern: send a
  `session.instructions.append` ("stop speaking now"), mute the output `<audio>` element ~0.9 s so queued audio
  is not heard, then unmute. Called on every student move when the Professor is speaking or has fresh commentary.
- Memory: the live model keeps the whole conversation (128k, compacted to instructions + 8k at 90%) and it survives
  the idle fork; the delegation backend gets conversation context from OpenAI; only the comment writer was stateless.
- **Lesson notes (application memory).** Bug seen in testing: the student said "quero jogar o sistema Londres", then
  asked "qual o próximo movimento?"; the delegated backend answered with the engine's favourite (c4) because nothing
  told it about the plan. Fix: `/api/live/notes` folds each settled student utterance (client fires
  `onUserUtterance` ~1.8 s after the last transcript fragment) into a short PT-BR notes string (name, chosen opening,
  plans, preferences). The notes are injected everywhere: `get_position` tool output (`lessonNotes` + `studentSaid`),
  the comment request, a `session.thinking.append` on every change, and the session seed on fresh/forked sessions.
  The backend prompt now puts the student's plan before the engine (recommend the opening's typical move, checked with
  `evaluate_move`, and only override it if it loses more than half a pawn). Verified with a scripted delegation
  after 1.d4 d5: with the notes present the backend calls get_position → evaluate_move(Bf4) and recommends bishop f4.

Update 2026-09-21 (language switch): the app is English by default and Brazilian Portuguese when the URL carries
`?lang=pt-BR`. `src/lib/i18n/lang.ts` defines `Lang` ("en" | "pt-BR"); `LangProvider` (in the root layout, under a
Suspense boundary because it reads `useSearchParams`) exposes `useLang()` to the client, and `UI` in
`src/lib/i18n/ui.ts` holds every interface string. Everything the models see is keyed by language: the live and backend
instructions, the tool descriptions, the comment writer and lesson-notes prompts (`lang` travels in the request
bodies), the material/classification texts, the verifier messages, the greeting and the interrupt instructions. The
speech grammar has one lexicon per language (`LEXICONS` in `src/lib/mentions/grammar.ts`) over shared parsing rules;
the describer and the piece qualifier ("your pawn on c2" / "seu peão de c2") follow suit. Voices: `cedar`/`marin`
for English, `tempo`/`bossa` for Portuguese. Older notes below that quote Portuguese phrases still apply to the
Portuguese mode.

## 1. What the Live API gives us (researched from developers.openai.com)

| Topic | Finding |
|---|---|
| Model | `gpt-live-1`. Audio + text in/out. No images (the tutor cannot "see" the board; we feed it FEN/moves/engine lines as text). Knowledge cutoff Jul 31 2025. |
| Transport | WebRTC for browsers: mic track up, audio track down, data channel `oai-events` for JSON events. The SDP offer is sent by **our server** to `POST /v1/live/sessions` with the API key; the answer goes back to the browser. |
| Delegation | GPT-Live is a fast voice model. Anything requiring reasoning/tools is delegated to a backend. Two modes: **responses** (OpenAI runs a Responses model, e.g. `gpt-5.6-terra` / `gpt-5.6-luna`, with function tools we declare) or **client** (we run the backend ourselves). |
| Function calls | In responses mode, tool calls arrive on the data channel as `response.event` envelopes wrapping `response.output_item.done` (`call_id`, `name`, `arguments`). We answer with `response.item.create` `{type:"function_call_output"}` then `response.create`. Tools can therefore run **in the browser**, where the board and Stockfish already live. |
| Context injection | `session.thinking.append` (silent context, max 500 tokens), `session.commentary.append` (model paraphrases it aloud, not guaranteed), `session.instructions.append` (steer behaviour). `session.input` seeds prior text messages at session creation. No typed user text mid-session. |
| Transcripts | `session.input_transcript.delta` (user) and `session.output_transcript.delta` (assistant), fragments with `start_ms`/`end_ms`. No turn-complete event. |
| Interruptions | Full duplex; the model listens while speaking. Mute via `session.input_audio.mute` (does not stop billing or backend work). |
| Session limits | 128k context; auto-compaction at 90% keeps instructions + 8,192 tokens of history. Duration limit exists but is unspecified (`reason: "expired"`). Free tier unsupported; Tier 1 = 25 concurrent sessions. |
| Pricing | **$0.05 / minute, billed per second**, for the whole session (speaking, silence, backend working). 15 s pre-billed at creation, credited back once running. Backend model tokens billed separately at normal rates. A 30-min lesson ≈ $1.50 + backend tokens. |
| Close | Send `session.close`, keep the connection open until `session.closed` arrives (`usage.seconds`, `reason`). |
| Voices | 22 built-in (e.g. `marin`, `cedar`, `meridian`, `gleam`, `vesper`; Brazilian Portuguese `bossa`, `tempo`). Set via `session.audio.output.voice`. |
| SDK | `openai@7.15.0` has `client.live.create({ session, transport })`. |

## 2. Proposed architecture

```
Browser (Next.js page)                              Next.js API route            OpenAI
┌──────────────────────────────┐   POST /api/live/session   ┌───────────────┐   POST /v1/live/sessions
│ mic ─┐                       │ ─────────────────────────▶ │ holds         │ ───────────────────▶
│      ├─ RTCPeerConnection ◀──┼──── SDP answer ─────────── │ OPENAI_API_KEY│ ◀───────────────────
│ 🔊 ◀─┘   data channel        │                            └───────────────┘
│  useLiveTutor()              │ ◀═══ WebRTC audio + oai-events (direct to OpenAI) ═══▶
│  ├ board state + move log    │
│  ├ Stockfish (already there) │   tools executed here: get_position, get_engine_lines,
│  └ arrows/highlights         │   draw_arrows, highlight_squares, clear_annotations
└──────────────────────────────┘
```

- **Server**: one Next.js route handler. Reads `OPENAI_API_KEY` from `.env.local`, builds the session config, forwards the browser's SDP offer, returns the answer. No other server needed; `npm run dev` is enough.
- **Delegation**: responses mode. Live prompt = personality + "delegate when the user asks about the position, a plan, an evaluation, or why a move was good/bad". Backend prompt = the coaching brain, with function tools that run in the browser.
- **Move context**: after every move the browser sends `session.thinking.append` with SAN, new FEN, engine eval before/after, best line. That keeps the tutor current without a tool round trip.
- **UI**: a "Coach" card in the side panel: Connect / End, mute, voice picker, live transcript, elapsed time + running cost estimate, connection status. Coach-drawn arrows use a distinct colour.

## 3. Tools (browser-executed)

| Tool | Purpose |
|---|---|
| `get_position` | FEN, side to move, move list (SAN), game status, last move. |
| `get_engine_lines` | Top 3 lines with evals from the local Stockfish (waits until depth ≥ N). |
| `evaluate_move(san)` | Plays a hypothetical move on a copy, returns engine eval of the result (for "what if I play Nf3?"). |
| `draw_arrows(list)` / `highlight_squares(list)` / `clear_annotations` | Let the coach point at things on the board. |
| `play_move(san)` (optional) | Only if the tutor is also the opponent, or if the user says "play it for me". |

## 4. Steps

1. Setup: `npm i openai`, `.env.local` with `OPENAI_API_KEY`, `/api/live/session` route. Verify with a curl that a session is created.
2. `useLiveTutor` hook: WebRTC connect, data channel event parsing, transcript state, close handling, usage tracking.
3. Coach UI card + mic mute + transcript.
4. Tools: dispatch `response.event` function calls to local handlers; return outputs; `response.create`.
5. Move context: `session.thinking.append` after each move (and after undo / new game).
6. Prompts (live + backend), voice, cost display. Tune with real voice testing (needs a human; the in-app browser cannot speak).

## 5. Known limitations to design around

- No guaranteed proactive speech: the coach may not comment on every move even if asked to.
- No typed text mid-session (only voice); a "text to coach" box would need `session.input` at start or a restart.
- Muting keeps billing; we should auto-close after N minutes of silence (configurable).
- Tools cannot be cancelled once the backend starts them.
- The Live model itself is small; keep the live prompt short and put chess knowledge in the backend prompt + engine data.

## 6. Engine memory (2026-09-11)

Problem: every delegated question cost ~3 s and a "deixa eu analisar" filler, because each backend tool call is a
full model round trip (get_position → evaluate_move → get_engine_lines → answer) and `evaluate_move` searched on demand.

- `src/lib/move-table.ts` (`MoveTableEngine`): a third Stockfish worker that, whenever it is the student's turn,
  runs ONE MultiPV search covering every legal move (target depth 14) and keeps tables for the last 4 positions.
  Measured after 2.Bf4 c5 (33 legal moves): depth 9 ready before the student could ask, depth 12 at ~1.2 s,
  complete (14) at ~2.4 s. It is stopped while the opponent engine thinks, so the Professor's move is not slowed.
- `get_position` now returns `candidateMoves` (all legal moves, best first, with eval, best reply, short line) and
  `candidateDepth`; ~3.5 KB of JSON, 2 ms. The backend prompt says it is normally the only tool needed.
  `parallel_tool_calls` is on.
- `evaluate_move` takes `moves: string[]` (a sequence). A single move is a memory hit (1 ms); sequences search
  (depth 12, ~40 ms in the opening).
- Live prompt: no "estou analisando" filler; silence or a short "hmm", a varied sentence only if it drags past ~5 s.
- The "Eventos" panel now logs each delegation: which tools the backend asked for and when, how long each tool took,
  and the total delegation time. Use it to see whether the remaining wait is model round trips.
- Dev hook: `window.__teachess = { tools, moveTable }` in development, to call tools from the console.


## 7. Speech → board highlights (2026-09-11)

Goal: whatever the Professor mentions (a piece, a move, a check) lights up on the board at the moment it is said, and the
transcript keeps those mentions as hoverable chips that restore the board of that moment.

Facts the design relies on (verified in `openai` SDK types + delegation guide):
- `session.output_transcript.delta` carries `start_ms`/`end_ms` on the session timeline; no turn-done event; fragments can
  split words.
- In Responses delegation the backend's answer text is forwarded to the browser (`response.event` →
  `response.output_text.delta/done`) before the voice model paraphrases it.
- `session.commentary.append` is paraphrased, so the spoken wording is never exactly ours.

Design: **what** and **when** are separate.
- *What* = a `Plan` (`src/lib/mentions/types.ts`): ordered mentions written in chess (SAN lines from a known FEN, or a
  piece on a square). chess.js resolves everything on the client (`resolve.ts`): which knight can reach a4, the origin of
  the queen in `Qh5+`, the checking piece(s) → king arrow, captures. Invalid parts are dropped or repaired.
  Sources: `/api/live/comment` now returns structured `parts` (strict JSON schema; speech = concatenated `text`s; the voice
  model only receives the speech); delegated answers are parsed from the forwarded backend text with the PT-BR grammar
  (`grammar.ts`, `planFromProse`); spontaneous speech has no plan.
- *When* = the transcript. `SpeechMatcher` (`matcher.ts`) re-parses each row as fragments arrive, finds piece words and
  squares ("cavalo de f3 para a4", "sua dama", "toma em f7", "e 5"), matches them to the pending plan steps (order-aware
  scoring with a lookahead of 4) or resolves heuristically against the row's FEN (unique piece, else last-moved piece,
  else all candidates dimmed). Phrases touching the end of the text are held 250 ms so they can grow.
- Timing: `LiveTutorClient` listens to the Professor's audio (analyser on the remote track); a speech onset after ≥500 ms
  of silence is paired with the transcript burst that started nearest to it, giving `timelineOffset` (local = session ms +
  offset). Mentions are scheduled at their interpolated session time. `SYNC_BIAS_MS` in `live-client.ts` is the manual
  correction; the measured lead is shown in the coach panel header ("sync +120ms") and logged in Eventos.
- Board: coach layer with focus/dim levels (`CoachSquare`, arrow colours `coach/capture/check` + `*Dim`), fading 4 s after
  the last mention once the Professor is quiet, cleared on any move/undo/new game (`boardChanged()`).
- Transcript: rows store `fen` + `mentions` (char ranges). `TranscriptText` renders chips; hovering a chip shows the board
  at that mention's FEN (position before that step, earlier steps of the same variation dimmed) read-only with a banner;
  hovering "Professor:" shows all of the row's mentions on the row's FEN.
- Dev: `window.__teachess.offlineLesson()` shows the coach panel without a session; `__teachess.client.debugSpeak(text)`
  streams `text` as Professor speech (fragments at ~15 chars/s, transcript 300 ms ahead of "audio") to try the pipeline.
- Prompts: backend and comment writer are told to name the square of a specific piece ("o cavalo de f3") and to describe
  moves as "cavalo de c3 para a4"; the live prompt says the same in one sentence.

To verify with a real ear: whether highlights land on the word (adjust `SYNC_BIAS_MS`), and how the live model's transcript
spells squares (the grammar accepts "f3", "f 3" and "f três"; "a 4"/"e 4" spaced forms only after a piece or preposition).

Fixes after the first voice test (2026-09-11): the transcript spells squares as "D dois", "A cinco" (handled). "PIECE em SQ"
with no such piece on SQ is now a move to SQ ("peão em e3", "bispo em f4"); "dar um cheque/xeque em SQ" binds the square
as the destination; backend prose is resolved against the base position first so alternatives ("Bb5, or the safer Be2")
don't chain, falling back to the position after the previous moves only when the move is illegal at the base; an origin-
square match alone no longer lets a phrase take a plan step; a phrase that grows after being emitted ("peão de d2" →
"... para d4") is re-resolved and replaces the earlier mention (`replacesId`); piece-only mentions with more than two
candidates ("meus peões") are dropped; ambiguity tie-breaks use the last two move destinations.

## 8. Unrequested move hints and cut-off speech (2026-09-11)

Symptoms from a voice test: after every student move the Professor said "the best move now is X" before reacting to the
move, announced its own reply before playing it, and sometimes stopped mid-sentence.

- Cause 1: `buildThinking` put "Melhores lances agora: …" and "o melhor era …" in the `session.thinking.append` after each
  move, and the live model read it aloud. Thinking now carries only the move, its classification, evals, material and
  status, prefixed with "[Contexto silencioso: não comente agora…]". Live prompt: never speak because of a thought, never
  suggest the student's next move unless explicitly asked (then delegate), never announce a Professor move before the app
  reports it. Backend prompt: concrete move suggestions only when asked. Comment writer: never hint the next move; the
  better move may only be discussed in the past tense about the move just played.
- Cause 2: `stop()` appended "stay silent and listen" to the session instructions on every student move made while a
  comment was fresh (<10 s), even after it had been spoken. `session.instructions.append` is cumulative, so the standing
  order made the model go quiet later. The instruction is now scoped to the stale comment and says the next one must be
  spoken; "fresh" also requires that no speech was heard since the comment was sent (output analyser).
- Cause 3: a new comment arriving mid-sentence made the model abandon the sentence. `sendCommentary` now waits (≤5 s)
  for the Professor to be quiet and re-checks that the board has not moved on before sending.

## 9. Double narration, push-to-talk, piece names (2026-09-11)

Symptoms from the second voice test: every turn was narrated twice ("Joguei peão pra d5…" and then, seconds later, the
real comment "Excelente começo. Eu jogo peão de d5…"); the mic was always open; the Professor said "seu peão" with eight
pawns on the board and the board lit all of them ("♙?" chip).

- **One speech per turn.** The first narration came from the per-move `session.thinking.append`: the SDK documents
  thinking as context that "does not directly request speech, but can influence later speech", and in practice the live
  model announced the Professor's move from it, then spoke the comment too. The per-move thinking is gone (`buildThinking`
  removed); the comment writer's `session.commentary.append` is the only speech about moves. The live prompt now says:
  one ready comment per turn, speak it once, never comment a move before it arrives. Notes and undo still use thinking
  (rare, and not worth speaking). The backend gets the position from `get_position`, so the live model does not need
  per-move context.
- **Push-to-talk.** The mic track starts disabled and is enabled only while Space (or the "Segure Espaço para falar"
  button, pointer-captured) is held: `LiveTutorClient.setTalking(on)`. Muting is done by disabling the track only, so the
  session keeps receiving a silent stream exactly like the no-mic case (no `session.input_audio.mute` events: they were
  never verified to leave commentary unaffected). A Space press while the session is idle wakes it; the mic-level wake
  is gone. Space is ignored in inputs; keydown/keyup are prevented so a focused button is not clicked; window blur
  releases. The panel shows "ouvindo você" while the mic is open.
- **Piece names.** Three layers: (1) prompts (writer, backend, live) say the square is mandatory whenever the side has
  more than one piece of the kind ("seu peão de c2"), optional only for the king and a lone queen, and the live model must
  keep squares verbatim; `get_position` returns `pieceTypesNeedingSquare` per side. (2) `qualifyPieceParts`
  (`src/lib/mentions/qualify.ts`) rewrites the writer's piece parts deterministically: if the square is confirmed on the
  board and the side has several of that piece, " de <casa>" is inserted after the noun ("seu peão" → "seu peão de c2",
  "a dama dele" → "a dama de d1 dele"); unique pieces, plurals and unconfirmed squares are left alone. Piece parts now
  carry a `fen` (the writer's `from`, or the first of current/before_tutor/before_student where the piece really is on
  that square), so "capturei seu peão de d5" resolves to the position where the pawn still stood. (3) `planFromParts`
  drops piece steps with more than two candidate squares, so an unpinned "seu peão" no longer lights up every pawn (the
  transcript heuristics then pick the last-moved pawn or nothing).
- **Found while testing the route:** `gpt-5.6-luna` is a reasoning model and reasoning tokens count against
  `max_output_tokens`. With the writer's old cap of 600, a call could spend all 600 on reasoning and return an empty
  or truncated JSON, which the fallback then wrapped as plain text (raw JSON handed to the voice model). Both the
  comment writer and the notes route now send `reasoning: { effort: "low" }` with a roomier cap (2000 / 800), and the
  writer returns 502 on an incomplete response or unparsable JSON so the client simply skips that turn's comment.
  Measured after the fix: ~130 reasoning tokens, ~250–340 output tokens per comment.

## 10. Time to speech after a turn (2026-09-11)

Symptom: ~14 s between the Professor's reply on the board and its voice. Measured after the fix, in the app (events
panel), two turns: **3.0 s and 4.4 s** from the reply to audible speech. The reply itself now appears 0.3 s after the
student's move in the opening.

Where the 14 s came from, in order of size:
1. **Duplicate engine searches.** `useChessGame` returned a new object on every render and the tutor-reply effect
   listed `game` as a dependency, so every render during the Professor's turn (each engine flush, every ~80 ms)
   cancelled the effect and queued one more `player.search` on the serialised worker. The reply came from the last
   run, after the whole pile drained; the comment only started after that. Fix: the hook memoises its result, and the
   effect is keyed on `game.fen` / `game.history.length` / `game.turn` and uses `gameRef` to play the move.
2. **Comment writer: 2.7–4.8 s** with `gpt-5.6-luna`, `reasoning: low`, standard tier, on a 2.4k-token input. Measured
   with the same input: no reasoning 2.2–3.0 s; no reasoning on `service_tier: "priority"` 1.4–1.7 s, with the same
   quality (every fact is pre-computed; there is nothing to reason about). In-app it measures 2.0–3.1 s (bigger
   inputs as the game goes on, dev server). Priority pricing on luna is negligible (~$0.002 per comment).
3. **Waits on the engine before and after the reply.** Before: up to 2 s for depth 12 on the student's move, plus a
   300 ms pause added on top (now the search, the analysis wait ≤1.5 s and a 300 ms minimum run concurrently). After:
   the comment waited up to 2.5 s for the student's position although the engine had already left it (its snapshot is
   frozen at whatever depth it reached: now no wait), and up to 1.5 s for depth 12 on the new position (now depth 10,
   ≤0.7 s; measured 0.1–0.2 s in the opening).
4. **Voice model reaction**: `session.commentary.append` → first audible audio is ~0.95–1.06 s (the ack arrives ~0.9 s
   after the send, "timeline" range ~200 ms). This is the floor of the API; nothing in our code adds to it.
5. In `next dev`, the first `/api/live/comment` request also compiles the route (seconds). The lesson start now warms
   the route with a GET (204), which also covers cold starts in production.

Also on the delegation path (student questions): the Responses backend had no `reasoning` setting (luna's default is
medium), so every answer thought for seconds before its first tool call. The session config now sends
`reasoning: low`, `service_tier: priority`, `text.verbosity: low`. The notes writer runs with no reasoning + priority.

Instrumentation kept in the events panel: "aluno jogou", "Professor jogou … Nms após o lance", "turno: contexto pronto
em … / comentário escrito em …", "comentário aceito Nms após o envio", "voz: áudio do Professor Nms após o comentário
(Ns após o lance)"; the header shows "fala N.Ns após o lance" for the last turn.

Tried and rejected: a compact output schema for the writer (plain strings for text parts, objects only for pieces
and lines) cut the output from ~140 to ~80 tokens (~0.4 s) but one run in three produced garbage text from the
constrained decoder (mixed anyOf string/object items). The current all-fields schema is kept.

What is left, if 3–4 s is still too long: the writer (2–3 s) is the only big item. The next lever is architectural,
not tuning: speak in two acts (react to the student's move from local facts via `session.commentary.append` right
after the reply, then the writer's comment), or let the live model phrase the whole turn from a factual brief and
drop the writer from the critical path. Both trade the writer's pedagogy and structured highlights for ~1.5 s.

## 11. The reply lands when the Professor says it (2026-09-11)

The board used to run about three seconds ahead of the voice: the reply appeared 0.3 s after the student's move and
was announced at 3–4.4 s. Now the reply is **decided** immediately but **held**, and it goes on the board at the
moment the Professor names it ("eu jogo peão para d5").

How it works: nothing new had to be invented, because the machinery for "when is this phrase audible" already exists
for the board highlights. The writer already returns the Professor's move as a structured part
(`{type:"line", moves:[san], from:"before_tutor"}`), and `SpeechMatcher` already fires a `MatchEvent` at the moment a
mention is estimated to be heard, calibrated against the real audio through the analyser on the output track. So
`onMention` just checks whether the mention is a move by the Professor's colour with the held reply's SAN, and plays
it right there (`landReply`).

What the delay does to the turn, measured in a lesson (events panel, `boardChanges`):

| Turn | Comment | Reply landed on |
|---|---|---|
| 1.e4 | short praise | 8.9 s, "peão para d5" |
| 3.Na3 | long correction | 11.5 s, "peão de d5 captura em e4" |
| 4.Ne5?? | queen blunder | 6.7 s, "bispo captura em d1" |

The student is listening for all of it, and their own move has already given them the sound and the classification
badge. The writer is still the long pole before speech starts (2.4–3.7 s).

**Fallbacks, in the order they can fire.** Every path out of `commentOnTurn` leaves the move to these, so it can be
delayed but never lost.
- No live session: `REPLY_SILENT_MS` (800 ms), a plain pause. Measured 820 ms.
- Writer never returns: `REPLY_WATCHDOG_MS` (8 s from the decision).
- Comment handed over but he never speaks: `REPLY_NO_SPEECH_MS` (2.5 s).
- He speaks and stops without naming the move: `REPLY_QUIET_MS` (1.2 s of silence, on top of the ~600 ms the analyser
  needs to call it silence).
- `REPLY_HARD_CAP_MS` (25 s) under everything, whatever the speech detection does.

**A blind cap measured from the first sound does not work**, and this was found in testing: with a 6 s cap the second
turn landed the move mid-sentence, three seconds before he said it, because a correction ("seu lance foi um erro: era
melhor...") runs eight seconds before he ever names his own move. While he is audible the deadline is now pushed
along in front of him (`REPLY_SPEAKING_GRACE_MS`); silence is what actually triggers a fallback.

**Consequences handled elsewhere:**
- The comment writer is fed the position the reply *will* create, not the one on the board: history, material, status
  and records all include the held move, or it would announce a capture while claiming the piece is still there.
- The position after the reply is never analysed by the background engine (it follows the board), so it is searched
  aside on the opponent's worker (`analyseAside`).
- `get_position` reports `pendingTutorMove` and returns `candidateMoves` for the position after it, and the engine
  memory is pre-warmed on that position. Verified: 28 candidates at depth 13 within 1.5 s of the student's move. A
  student who interrupts to ask "what do I play?" mid-announcement gets an answer about the right position.
- A takeback during the announcement cancels the held move and cuts him off with `STOP_UNDO_INSTRUCTION` (the generic
  stop text claims the student played another move, which would be a lie here). Verified: the move never appeared.
- The panel's turn metric now measures from the student's move to the voice, since the reply no longer precedes it.

Knob if the wait feels long: the writer's prompt puts a reaction before the announcement. Asking it to announce first
would cut several seconds, at the cost of the teaching order the comment currently follows.

## 12. The board has the last word (2026-09-11)

Symptoms from a voice test (1.d4 d5 2.Bf4 Nc6 3.c4 e5 4.Bxe5 Nxe5 5.dxe5 dxc4): the turn comment ended with "Sua dama
agora pode capturar em c4, recuperando o material" (the queen on d1 cannot reach c4, and hinting the student's move is
forbidden); the student then asked "minha dama pode pegar em c4?" and the delegated backend answered "Pode, mas não é
o melhor"; the transcript chip for the student's words showed ♕d1×d8+, and an earlier one showed ♗e5→f4 for "seu bispo
de f4 tomou em e5".

Causes, in order:
1. **Nothing verified the writer's chess claims.** `planFromParts` dropped illegal line parts *for the highlights* and
   went on; the speech text still went to the voice model as written. The writer runs with no reasoning, so a wrong
   move in a plausible sentence is exactly the kind of slip it makes.
2. **The backend confirmed from the conversation, not from the data.** The Professor's own sentence was in the
   conversation the delegation sees; checking a flat, eval-sorted list of ~30 SAN moves for the *absence* of "Qxc4"
   is a lookup a low-reasoning model skips when the context already "says" the move exists.
3. **Two grammar fallbacks invented moves.** "pegar em c4" bound c4 as the piece's square instead of the capture
   square, and the resolver then took "the only capture that queen has" (Qxd8+). A capture phrase cut off by the
   streaming transcript ("bispo de f4 tomou") fell into the "piece em square = move to square" rule, and with the
   null-move flip the bishop, already on e5, got an arrow back to f4.

What changed (generate → verify → repair, with the app as the source of truth):
- `src/lib/mentions/validate.ts`: `verifyWriterParts` checks every part of the writer's answer with chess.js against
  the three positions of the turn. Piece parts must hold the piece on the named square in the named position (a square
  that is in the spoken words is accepted if the piece stood there anywhere in the turn); line parts must be legal from
  the named position, else are repaired to the turn position where they are; a line of the *student's* moves from the
  current position is a hint and is rejected as such; and every move described in plain words, marked or not, must be
  possible somewhere in the turn (`parsePhrases` over the whole speech, either side's moves counting so threats pass).
  Problems are worded in Portuguese for the model ("dama branca (em d1) não pode ir para c4; lances possíveis dessa
  peça: Qc2, Qb3, …").
- `/api/live/comment`: on problems the writer gets one more attempt with its own answer and the problem list
  (`MAX_ATTEMPTS = 2`, ~1.5 s only when something was wrong). If that fails too, or a model call fails, the route
  returns the app's own announcement ("Meu lance: peão de d5 toma em c4.", built by `describeMove`), which cannot be
  wrong and still lands the held reply on the word. The response carries `verification` (attempts, problems,
  fallback); the events panel shows it on the "comentário escrito" line. The writer's prompt now says the board checks
  every claim and rejects the answer.
- `get_position` returns `legalMovesByPiece` ("Qd1": ["Qxd8+", "Qd2", …], same position as candidateMoves, pending
  reply included). The backend prompt has a legality rule: that list is complete, a move not in it is impossible even
  if the student or an earlier Professor comment said otherwise, and "can I play X?" is answered by looking X up there
  first. `evaluate_move` explains an illegal sequence (which move, why, what the piece can do). The live prompt: never
  confirm a move is possible without the backend, delegate legality questions even when a comment seems to answer,
  and never add moves or squares to a ready comment.
- Grammar: "toma/pega em SQ" binds the capture square; a capture phrase resolves only to a capture matching the stated
  origin and square (else to the piece plus the square it was said to take on, never another capture); "piece em SQ"
  becomes a move only when the phrase is not a capture; adverbs ("agora", "ainda", …) no longer end a phrase; and a
  piece named on a square it has just left ("seu bispo de f4 tomou em e5") is resolved in the recent position where it
  stood (`recentFens`, the positions before the last four moves).
- The backend's answers cannot be gated in Responses delegation (verified in the delegation guide: reviewing backend
  results "does not approve every word GPT-Live speaks"), so `impossibleClaims` only logs "⚠ backend descreveu lance
  ou peça que não existe" in the events panel. Gating them for real means client delegation: the app would run the
  Responses call itself, feed the position inline (no tool round trip), verify the answer and only then
  `session.commentary.append` it. That is the next architectural step if the backend still slips after this.
