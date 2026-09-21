"use client";

import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { useCallback, useMemo, useState } from "react";

export type GameResultKind =
  | "playing"
  | "check"
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "fifty-move"
  | "insufficient";

export interface GameStatus {
  kind: GameResultKind;
  over: boolean;
  winner: Color | null;
  turn: Color;
}

function computeStatus(chess: Chess): GameStatus {
  const turn = chess.turn();
  const winner: Color = turn === "w" ? "b" : "w";
  if (chess.isCheckmate()) return { kind: "checkmate", over: true, winner, turn };
  if (chess.isStalemate()) return { kind: "stalemate", over: true, winner: null, turn };
  if (chess.isInsufficientMaterial()) return { kind: "insufficient", over: true, winner: null, turn };
  if (chess.isThreefoldRepetition()) return { kind: "threefold", over: true, winner: null, turn };
  if (chess.isDrawByFiftyMoves()) return { kind: "fifty-move", over: true, winner: null, turn };
  if (chess.inCheck()) return { kind: "check", over: false, winner: null, turn };
  return { kind: "playing", over: false, winner: null, turn };
}

/** Status of an arbitrary position, for a move that has been decided but not played yet. */
export function statusForFen(fen: string): GameStatus {
  return computeStatus(new Chess(fen));
}

export function useChessGame() {
  // The engine instance is mutable; `version` is bumped after each mutation so
  // the derived snapshot below recomputes.
  const [chess] = useState(() => new Chess());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const snapshot = useMemo(() => {
    const board = chess.board();
    const history = chess.history({ verbose: true });
    const status = computeStatus(chess);
    let checkedKingSquare: Square | null = null;
    if (chess.inCheck()) {
      for (const row of board) {
        for (const cell of row) {
          if (cell && cell.type === "k" && cell.color === status.turn) checkedKingSquare = cell.square;
        }
      }
    }
    return { board, history, fen: chess.fen(), status, checkedKingSquare, version };
  }, [chess, version]);

  const legalMoves = useCallback(
    (square: Square): Move[] => chess.moves({ square, verbose: true }),
    [chess],
  );

  const makeMove = useCallback(
    (from: Square, to: Square, promotion?: PieceSymbol): Move | null => {
      if (chess.isGameOver()) return null;
      try {
        const mv = chess.move({ from, to, promotion });
        bump();
        return mv;
      } catch {
        return null;
      }
    },
    [chess, bump],
  );

  const undo = useCallback((): Move | null => {
    const mv = chess.undo();
    if (mv) bump();
    return mv;
  }, [chess, bump]);

  const reset = useCallback(() => {
    chess.reset();
    bump();
  }, [chess, bump]);

  // One object per position. Effects that list `game` as a dependency must not re-run on every render: a fresh
  // object each render made the tutor's reply effect restart (and queue another engine search) on every engine flush.
  return useMemo(() => {
    const { board, history, fen, status, checkedKingSquare } = snapshot;
    const lastMove = history.length > 0 ? history[history.length - 1] : null;
    return { board, history, fen, status, turn: status.turn, lastMove, checkedKingSquare, legalMoves, makeMove, undo, reset };
  }, [snapshot, legalMoves, makeMove, undo, reset]);
}
