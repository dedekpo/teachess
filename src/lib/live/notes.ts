"use client";

import type { NotesRequest } from "@/app/api/live/notes/route";

/** Asks the server to fold a student utterance into the lesson notes. Returns the new notes, or null if unchanged/failed. */
export async function updateLessonNotes(req: NotesRequest): Promise<string | null> {
  try {
    const res = await fetch("/api/live/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { notes?: string; changed?: boolean };
    return data.changed && typeof data.notes === "string" ? data.notes : null;
  } catch {
    return null;
  }
}

/** Silent context sent to the live model whenever the notes change. */
export function notesThinking(notes: string): string {
  return `Notas da aula (memória do aplicativo, use para manter coerência): ${notes}`;
}
