"use client";

import type { Color, PieceSymbol } from "chess.js";
import { pieceImage, type DisplayPos } from "@/lib/chess-utils";
import { useLang } from "@/lib/i18n/LangProvider";
import { UI } from "@/lib/i18n/ui";
import { PIECE_NAMES } from "@/lib/mentions/describe";

interface PromotionDialogProps {
  color: Color;
  position: DisplayPos; // display position of the promotion square
  onPick: (piece: PieceSymbol) => void;
  onCancel: () => void;
}

const CHOICES: PieceSymbol[] = ["q", "n", "r", "b"];

export function PromotionDialog({ color, position, onPick, onCancel }: PromotionDialogProps) {
  const lang = useLang();
  const t = UI[lang].promotion;
  // Picker extends from the promotion square toward the middle of the board.
  const fromTop = position.row === 0;
  const items = fromTop ? [...CHOICES, "x" as const] : ["x" as const, ...CHOICES].reverse();
  // When anchored at the bottom, the order visually reads (from the square upward) q, n, r, b, x.

  return (
    <>
      <div
        className="absolute inset-0 z-30"
        style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onCancel();
        }}
      />
      <div
        className="absolute z-40 flex w-[12.5%] flex-col overflow-hidden rounded-md bg-white shadow-2xl"
        style={{
          left: `${position.col * 12.5}%`,
          ...(fromTop ? { top: 0 } : { bottom: 0 }),
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        {items.map((item) =>
          item === "x" ? (
            <button
              key="x"
              type="button"
              aria-label={t.cancel}
              className="flex aspect-[2/1] w-full items-center justify-center bg-neutral-200 text-neutral-600 hover:bg-neutral-300"
              onClick={onCancel}
            >
              ✕
            </button>
          ) : (
            <button
              key={item}
              type="button"
              aria-label={t.promoteTo(PIECE_NAMES[lang][item])}
              className="aspect-square w-full hover:bg-amber-200"
              onClick={() => onPick(item)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pieceImage(color, item)} alt={item} draggable={false} className="h-full w-full" />
            </button>
          ),
        )}
      </div>
    </>
  );
}
