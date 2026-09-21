# TEACHess

A real-time, voice-driven chess instructor built on the OpenAI **GPT-Live-1** API, with **Stockfish** running in the browser so every recommendation is grounded in real engine analysis.

You play a game against the Professor. It plays the other side with Stockfish at a chosen strength, comments on your moves out loud, answers questions mid-game, and draws arrows and highlights on the board. You can interrupt it at any time by holding the space bar and talking.

## How it works

- **Voice layer.** The browser opens a WebRTC session with GPT-Live-1. The API key stays on the server: the browser sends its SDP offer to `/api/live/session`, which attaches the key and session config and returns the answer.
- **Analytical backend.** Chess questions are delegated by the live model to a text model (`gpt-5.6-luna`) that has tools: `get_position`, `get_game_history`, `get_engine_lines`, `evaluate_move`, `draw_arrows`, `highlight_squares`, `clear_annotations`. Every legal move is pre-evaluated by the engine and handed to the model, so it cannot invent moves that do not exist.
- **Engine.** Stockfish 18 (lite, single-threaded WASM) runs in a Web Worker in the browser. One instance plays as the opponent at ~1320, ~1700 or ~2200 Elo, another analyses the position for the eval bar, move badges and the models.
- **Per-move commentary.** After each turn, `/api/live/comment` writes one short spoken comment from the engine facts and the recent transcript. Comments are dropped if the board changed while they were being written.
- **Lesson memory.** `/api/live/notes` folds what you say (your name, the opening you want to play, plans) into short notes that are injected into every tool result and prompt.
- **Idle pause.** After 90 seconds of silence (configurable) the session closes to save cost. Talking or making a move resumes it by forking the previous session, so the conversation is kept.

## Getting started

Requirements: Node 20 or newer and an OpenAI API key with access to GPT-Live-1.

```bash
npm install
cp .env.example .env.local   # then put your key in OPENAI_API_KEY
npm run dev
```

Open <http://localhost:3000>, pick your colour, the Professor's level and a voice, then start the lesson. Grant microphone access when the browser asks. Hold **Space** (or the on-screen button) to talk.

The interface and the tutor are in English by default. Add `?lang=pt-BR` to the URL for Brazilian Portuguese.

## Security note before deploying

The API routes under `src/app/api/live/` have **no authentication or rate limiting**. They exist so the OpenAI key never reaches the browser, but anyone who can reach a deployed instance can start live sessions and backend calls billed to your key.

This is fine for running locally. If you deploy it publicly or take it to production, add authentication (a login, a shared secret, or your host's access control) and rate limiting in front of those routes first.

## Project layout

```
src/app/api/live/   session, fork, comment and notes routes (server, holds the API key)
src/lib/live/       live client, session config and prompts, tools, lesson helpers, notes
src/lib/            chess utils, engine hooks, opponent player, game record, i18n, sounds
src/components/     board, arrows, eval bar, move list, coach panel, lesson setup
public/stockfish/   Stockfish 18 lite WASM build (GPL-3.0)
public/pieces/      cburnett piece set (CC BY-SA 3.0)
docs/               design notes and decision log
```

## License

TEACHess is released under the **GNU General Public License v3.0**. See [LICENSE](LICENSE).

The bundled Stockfish build is GPL-3.0 (see `public/stockfish/LICENSE.txt`). The chess piece graphics are the cburnett set from Wikimedia Commons, CC BY-SA 3.0 (see `public/pieces/LICENSE.md`).
