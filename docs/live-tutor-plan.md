# TEACHess voice tutor — plan (GPT-Live)

Status: implemented 2026-09-11 (first version). Decisions taken with the user:
tutor plays the opponent (Stockfish at a chosen Elo), comments on every student move and announces its own,
backend `gpt-5.6-luna`, Brazilian Portuguese with voice `tempo` (picker), always-on session once a lesson starts,
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
