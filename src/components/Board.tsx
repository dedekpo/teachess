"use client";

import type { Chess, Color, Move, PieceSymbol, Square } from "chess.js";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ARROW_RGBA,
  HIGHLIGHT_RGBA,
  FILES,
  RANKS,
  type Arrow,
  type SquareHighlightColor,
  arrowColorFromModifiers,
  fromDisplay,
  highlightColorFromModifiers,
  isLightSquare,
  pieceImage,
  toDisplay,
} from "@/lib/chess-utils";
import { Arrows } from "./Arrows";
import { PromotionDialog } from "./PromotionDialog";

type BoardMatrix = ReturnType<Chess["board"]>;

interface BoardProps {
  board: BoardMatrix;
  turn: Color;
  flipped: boolean;
  gameOver: boolean;
  lastMove: { from: Square; to: Square } | null;
  checkedKingSquare: Square | null;
  legalMoves: (sq: Square) => Move[];
  onMove: (from: Square, to: Square, promotion?: PieceSymbol) => boolean;
  /** Incremented by the parent to clear selection/annotations (e.g. new game, undo). */
  resetKey: number;
  /** Arrows drawn by the engine panel / coach (not cleared by left-click). */
  engineArrows?: Arrow[];
  /** Squares highlighted by the coach (not cleared by left-click). */
  coachSquares?: Square[];
  /** Which colours the human may move. Defaults to both. */
  playableColors?: Color[];
  /** Extra overlays rendered on top of the board (e.g. the engine panel). */
  children?: React.ReactNode;
}

interface DragState {
  from: Square;
  x: number; // px relative to board
  y: number;
}

interface PromotionState {
  from: Square;
  to: Square;
  color: Color;
}

const LIGHT = "#ebecd0";
const DARK = "#779556";
const LAST_MOVE = "rgba(255, 255, 51, 0.5)";
const SELECTED = "rgba(255, 255, 51, 0.5)";

export function Board({
  board,
  turn,
  flipped,
  gameOver,
  lastMove,
  checkedKingSquare,
  legalMoves,
  onMove,
  resetKey,
  engineArrows = [],
  coachSquares = [],
  playableColors = ["w", "b"],
  children,
}: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverSquare, setHoverSquare] = useState<Square | null>(null);
  const [highlights, setHighlights] = useState<Map<Square, SquareHighlightColor>>(new Map());
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [promotion, setPromotion] = useState<PromotionState | null>(null);
  const rightClickStart = useRef<Square | null>(null);
  const wasSelectedOnDown = useRef(false);

  // Clear transient state whenever the parent resets (new game / undo).
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setSelected(null);
    setDrag(null);
    setHoverSquare(null);
    setHighlights(new Map());
    setArrows([]);
    setPromotion(null);
  }

  const pieceAt = useCallback(
    (sq: Square) => {
      const f = sq.charCodeAt(0) - 97;
      const r = Number(sq[1]) - 1;
      return board[7 - r][f];
    },
    [board],
  );

  const selectedMoves = useMemo(
    () => (selected ? legalMoves(selected) : []),
    [selected, legalMoves],
  );
  const targetSet = useMemo(() => {
    const m = new Map<Square, Move>();
    for (const mv of selectedMoves) m.set(mv.to, mv);
    return m;
  }, [selectedMoves]);

  const squareFromEvent = useCallback(
    (clientX: number, clientY: number): { sq: Square | null; x: number; y: number } => {
      const el = boardRef.current;
      if (!el) return { sq: null, x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const col = Math.floor((x / rect.width) * 8);
      const row = Math.floor((y / rect.height) * 8);
      if (col < 0 || col > 7 || row < 0 || row > 7) return { sq: null, x, y };
      return { sq: fromDisplay(col, row, flipped), x, y };
    },
    [flipped],
  );

  const clearAnnotations = useCallback(() => {
    setHighlights((h) => (h.size ? new Map() : h));
    setArrows((a) => (a.length ? [] : a));
  }, []);

  /** Attempt a move; opens the promotion picker when needed. Returns true if handled. */
  const tryMove = useCallback(
    (from: Square, to: Square): boolean => {
      const candidates = legalMoves(from).filter((m) => m.to === to);
      if (candidates.length === 0) return false;
      if (candidates.some((m) => m.promotion)) {
        setPromotion({ from, to, color: turn });
        return true;
      }
      return onMove(from, to);
    },
    [legalMoves, onMove, turn],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { sq, x, y } = squareFromEvent(e.clientX, e.clientY);

    if (e.button === 2) {
      rightClickStart.current = sq;
      return;
    }
    if (e.button !== 0) return;

    // Any left click clears drawn arrows/highlights (chess.com behaviour).
    clearAnnotations();
    if (promotion || !sq) return;

    const piece = pieceAt(sq);

    // Click on a legal destination while a piece is selected -> move.
    if (selected && sq !== selected && tryMove(selected, sq)) {
      setSelected(null);
      return;
    }

    if (piece && piece.color === turn && playableColors.includes(piece.color) && !gameOver) {
      wasSelectedOnDown.current = selected === sq;
      setSelected(sq);
      setDrag({ from: sq, x, y });
      setHoverSquare(sq);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic or already-released pointers cannot be captured; dragging still works.
      }
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { sq, x, y } = squareFromEvent(e.clientX, e.clientY);
    setDrag((d) => (d ? { ...d, x, y } : d));
    setHoverSquare(sq);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const { sq } = squareFromEvent(e.clientX, e.clientY);

    if (e.button === 2) {
      const start = rightClickStart.current;
      rightClickStart.current = null;
      if (!start || !sq) return;
      if (start === sq) {
        const color = highlightColorFromModifiers(e);
        setHighlights((prev) => {
          const next = new Map(prev);
          if (next.get(sq) === color) next.delete(sq);
          else next.set(sq, color);
          return next;
        });
      } else {
        const color = arrowColorFromModifiers(e);
        setArrows((prev) => {
          const idx = prev.findIndex((a) => a.from === start && a.to === sq);
          if (idx === -1) return [...prev, { from: start, to: sq, color }];
          if (prev[idx].color === color) return prev.filter((_, i) => i !== idx);
          const next = [...prev];
          next[idx] = { from: start, to: sq, color };
          return next;
        });
      }
      return;
    }

    if (e.button !== 0 || !drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (sq && sq !== drag.from) {
      if (tryMove(drag.from, sq)) setSelected(null);
      // Illegal drop: piece snaps back and stays selected.
    } else if (sq === drag.from && wasSelectedOnDown.current) {
      // Clicking an already-selected piece deselects it.
      setSelected(null);
    }
    setDrag(null);
    setHoverSquare(null);
  };

  const onPointerCancel = () => {
    setDrag(null);
    setHoverSquare(null);
  };

  const onPromotionPick = (piece: PieceSymbol) => {
    if (!promotion) return;
    onMove(promotion.from, promotion.to, piece);
    setPromotion(null);
    setSelected(null);
  };

  const squares = useMemo(() => {
    const out: Square[] = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) out.push(fromDisplay(col, row, flipped));
    }
    return out;
  }, [flipped]);

  const dragPiece = drag ? pieceAt(drag.from) : null;

  return (
    <div
      ref={boardRef}
      className="relative aspect-square w-full select-none touch-none overflow-hidden rounded-sm shadow-2xl"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="grid h-full w-full grid-cols-8 grid-rows-8">
        {squares.map((sq, i) => {
          const piece = pieceAt(sq);
          const light = isLightSquare(sq);
          const { col, row } = toDisplay(sq, flipped);
          const isLast = lastMove !== null && (lastMove.from === sq || lastMove.to === sq);
          const isSelected = selected === sq;
          const target = targetSet.get(sq);
          const isCapture = target !== undefined && (target.flags.includes("c") || target.flags.includes("e"));
          const userHighlight = highlights.get(sq);
          const coachHighlight = coachSquares.includes(sq);
          const inCheck = checkedKingSquare === sq;
          const isHover = drag !== null && hoverSquare === sq && sq !== drag.from;
          const hidden = drag?.from === sq;

          return (
            <div
              key={sq}
              data-square={sq}
              className="relative"
              style={{ backgroundColor: light ? LIGHT : DARK }}
            >
              {(isLast || isSelected) && (
                <div
                  className="absolute inset-0"
                  style={{ backgroundColor: isSelected ? SELECTED : LAST_MOVE }}
                />
              )}
              {userHighlight && (
                <div
                  className="absolute inset-0"
                  style={{ backgroundColor: HIGHLIGHT_RGBA[userHighlight] }}
                />
              )}
              {coachHighlight && (
                <div className="absolute inset-0" style={{ backgroundColor: "rgba(155, 89, 182, 0.55)" }} />
              )}
              {inCheck && (
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(ellipse at center, rgba(255,0,0,1) 0%, rgba(231,0,0,1) 25%, rgba(169,0,0,0) 89%, rgba(158,0,0,0) 100%)",
                  }}
                />
              )}
              {col === 0 && (
                <span
                  className="absolute left-0.5 top-0.5 text-[min(1.6vw,0.8rem)] font-semibold leading-none"
                  style={{ color: light ? DARK : LIGHT }}
                >
                  {flipped ? RANKS[row] : RANKS[7 - row]}
                </span>
              )}
              {row === 7 && (
                <span
                  className="absolute bottom-0.5 right-0.5 text-[min(1.6vw,0.8rem)] font-semibold leading-none"
                  style={{ color: light ? DARK : LIGHT }}
                >
                  {flipped ? FILES[7 - col] : FILES[col]}
                </span>
              )}
              {piece && !hidden && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pieceImage(piece.color, piece.type)}
                  alt={`${piece.color}${piece.type}`}
                  draggable={false}
                  className={`absolute inset-0 h-full w-full ${
                    piece.color === turn && playableColors.includes(piece.color) && !gameOver ? "cursor-grab" : "cursor-default"
                  }`}
                />
              )}
              {target && !isCapture && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-1/3 w-1/3 rounded-full" style={{ backgroundColor: "rgba(0,0,0,0.14)" }} />
                </div>
              )}
              {target && isCapture && (
                <div
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ border: "min(1.2vw,7px) solid rgba(0,0,0,0.14)" }}
                />
              )}
              {isHover && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{ boxShadow: "inset 0 0 0 min(0.9vw,5px) rgba(255,255,255,0.65)" }}
                />
              )}
              <span className="sr-only">{i}</span>
            </div>
          );
        })}
      </div>

      <Arrows arrows={[...engineArrows, ...arrows]} flipped={flipped} colors={ARROW_RGBA} />

      {children}

      {drag && dragPiece && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pieceImage(dragPiece.color, dragPiece.type)}
          alt=""
          draggable={false}
          className="pointer-events-none absolute z-20 h-[12.5%] w-[12.5%] cursor-grabbing drop-shadow-lg"
          style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -50%) scale(1.1)" }}
        />
      )}

      {promotion && (
        <PromotionDialog
          color={promotion.color}
          position={toDisplay(promotion.to, flipped)}
          onPick={onPromotionPick}
          onCancel={() => {
            setPromotion(null);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
