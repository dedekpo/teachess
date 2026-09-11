"use client";

import { useEffect, useRef } from "react";
import { CLASS_COLOR, CLASS_LABEL_PT, CLASS_SYMBOL, type MoveRecord } from "@/lib/game-record";

function Cell({ r, current }: { r: MoveRecord | undefined; current: boolean }) {
  if (!r) return <span />;
  const symbol = CLASS_SYMBOL[r.classification];
  return (
    <span
      className={`flex items-center gap-1 rounded px-1 ${current ? "bg-white/15 font-bold" : ""}`}
      title={`${CLASS_LABEL_PT[r.classification]}${r.after ? ` · ${r.after.text}` : ""}${r.bestAlternative ? ` · melhor: ${r.bestAlternative}` : ""}`}
    >
      <span>{r.san}</span>
      {symbol && (
        <span className="text-[10px] font-bold" style={{ color: CLASS_COLOR[r.classification] }}>
          {symbol}
        </span>
      )}
      {r.after && <span className="ml-auto text-[10px] text-neutral-500">{r.after.text}</span>}
    </span>
  );
}

export function MoveList({ records }: { records: MoveRecord[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [records.length]);

  const rows: { n: number; white?: MoveRecord; black?: MoveRecord }[] = [];
  for (let i = 0; i < records.length; i += 2) {
    rows.push({ n: i / 2 + 1, white: records[i], black: records[i + 1] });
  }
  const last = records[records.length - 1];

  return (
    <div className="flex-1 overflow-y-auto font-mono text-sm">
      {rows.length === 0 && <p className="px-3 py-2 text-neutral-400">No moves yet.</p>}
      {rows.map((row, i) => (
        <div
          key={row.n}
          className={`grid grid-cols-[2.5rem_1fr_1fr] gap-1 px-3 py-1 ${i % 2 === 0 ? "bg-white/5" : ""}`}
        >
          <span className="text-neutral-400">{row.n}.</span>
          <Cell r={row.white} current={row.white === last} />
          <Cell r={row.black} current={row.black === last} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
