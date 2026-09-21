/** Languages the app speaks. English is the default; Portuguese is chosen with `?lang=pt-BR` in the URL. */
export type Lang = "en" | "pt-BR";

export const DEFAULT_LANG: Lang = "en";
export const LANGS: readonly Lang[] = ["en", "pt-BR"];

/** Maps a `lang` query value (or a JSON field) to a supported language; anything unknown is English. */
export function parseLang(value: unknown): Lang {
  if (typeof value !== "string") return DEFAULT_LANG;
  const v = value.trim().toLowerCase();
  if (v === "pt-br" || v === "pt_br" || v === "pt" || v.startsWith("pt-")) return "pt-BR";
  return DEFAULT_LANG;
}
