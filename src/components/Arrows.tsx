"use client";

import type { Square } from "chess.js";
import { toDisplay, type Arrow, type ArrowColor } from "@/lib/chess-utils";

interface ArrowsProps {
  arrows: Arrow[];
  flipped: boolean;
  colors: Record<ArrowColor, string>;
}

const WIDTH = 0.16;
const HEAD_LEN = 0.35;
const HEAD_WIDTH = 0.42;
const START_OFFSET = 0.32; // leave the origin piece visible

function center(sq: Square, flipped: boolean) {
  const { col, row } = toDisplay(sq, flipped);
  return { x: col + 0.5, y: row + 0.5 };
}

/** Shaft + head polygon from (x1,y1) to (x2,y2), start shortened by `offset`. */
function arrowPath(x1: number, y1: number, x2: number, y2: number, offset: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return "";
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const sx = x1 + ux * offset;
  const sy = y1 + uy * offset;
  const hx = x2 - ux * HEAD_LEN; // where the head starts
  const hy = y2 - uy * HEAD_LEN;
  const w = WIDTH / 2;
  const hw = HEAD_WIDTH / 2;
  const pts = [
    [sx + px * w, sy + py * w],
    [hx + px * w, hy + py * w],
    [hx + px * hw, hy + py * hw],
    [x2, y2],
    [hx - px * hw, hy - py * hw],
    [hx - px * w, hy - py * w],
    [sx - px * w, sy - py * w],
  ];
  return "M" + pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join("L") + "Z";
}

export function Arrows({ arrows, flipped, colors }: ArrowsProps) {
  return (
    <svg
      viewBox="0 0 8 8"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      {arrows.map((a) => {
        const from = center(a.from, flipped);
        const to = center(a.to, flipped);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const isKnight =
          (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
        const fill = colors[a.color];
        const key = `${a.from}-${a.to}`;

        if (isKnight) {
          // L-shape: travel the long leg first, then the short leg.
          const mid =
            Math.abs(dx) === 2 ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
          const legW = WIDTH / 2;
          const legDx = mid.x - from.x;
          const legDy = mid.y - from.y;
          const legLen = Math.hypot(legDx, legDy);
          const ux = legDx / legLen;
          const uy = legDy / legLen;
          const sx = from.x + ux * START_OFFSET;
          const sy = from.y + uy * START_OFFSET;
          // First leg as a rectangle extending slightly past the corner to join cleanly.
          const ex = mid.x + ux * legW;
          const ey = mid.y + uy * legW;
          const px = -uy;
          const py = ux;
          const leg =
            `M${(sx + px * legW).toFixed(3)},${(sy + py * legW).toFixed(3)}` +
            `L${(ex + px * legW).toFixed(3)},${(ey + py * legW).toFixed(3)}` +
            `L${(ex - px * legW).toFixed(3)},${(ey - py * legW).toFixed(3)}` +
            `L${(sx - px * legW).toFixed(3)},${(sy - py * legW).toFixed(3)}Z`;
          return (
            <g key={key} fill={fill}>
              <path d={leg} />
              <path d={arrowPath(mid.x, mid.y, to.x, to.y, 0)} />
            </g>
          );
        }

        return <path key={key} d={arrowPath(from.x, from.y, to.x, to.y, START_OFFSET)} fill={fill} />;
      })}
    </svg>
  );
}
