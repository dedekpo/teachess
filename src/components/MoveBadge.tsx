"use client";

import { CLASS_COLOR, type MoveClass } from "@/lib/game-record";
import { useLang } from "@/lib/i18n/LangProvider";
import { UI } from "@/lib/i18n/ui";

/**
 * The classification badge chess.com draws on the square a move landed on: a coloured disc with a glyph
 * (star for the best move, thumbs up for a good one, "?!" for an inaccuracy, and so on).
 *
 * Everything is drawn inside a 24x24 SVG so the badge scales with the board without any font-size arithmetic.
 */

/** Text glyphs are the classic annotation marks; the rest are drawn. */
const TEXT_GLYPH: Partial<Record<MoveClass, string>> = {
  brilliant: "!!",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

// Material Design icon outlines (simple geometry), fitted to the 24x24 box.
const STAR = "M12 16.9l-4.9 2.96 1.3-5.58-4.33-3.75 5.71-.49L12 4.8l2.21 5.24 5.71.49-4.33 3.75 1.3 5.58z";
const THUMB_UP =
  "M4 20.2h2.6v-8.9H4v8.9zm16.4-8.2c0-.79-.65-1.44-1.44-1.44h-4.55l.68-3.29.02-.23c0-.3-.12-.57-.32-.76l-.76-.75-4.74 4.74c-.27.26-.43.62-.43 1.02v7.2c0 .79.65 1.44 1.44 1.44h6.48c.6 0 1.11-.36 1.33-.88l2.17-5.08c.07-.16.1-.34.1-.52v-1.44z";

interface MoveBadgeProps {
  classification: Exclude<MoveClass, "unknown">;
}

export function MoveBadge({ classification }: MoveBadgeProps) {
  const label = UI[useLang()].badge[classification];
  const color = CLASS_COLOR[classification];
  const text = TEXT_GLYPH[classification];
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full" role="img" aria-label={label}>
      <circle cx="12" cy="12" r="10.6" fill={color} stroke="#ffffff" strokeWidth="1.6" />
      {text ? (
        <text
          x="12"
          y="12.6"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#ffffff"
          fontWeight="800"
          fontFamily="system-ui, -apple-system, Segoe UI, sans-serif"
          fontSize={text.length > 1 ? 11 : 14}
        >
          {text}
        </text>
      ) : classification === "best" ? (
        <path d={STAR} fill="#ffffff" />
      ) : classification === "good" ? (
        <path d={THUMB_UP} fill="#ffffff" />
      ) : (
        // excellent: a tick, drawn as a stroke so it stays crisp at any size.
        <path d="M6.6 12.4l3.5 3.5 7.3-7.8" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
