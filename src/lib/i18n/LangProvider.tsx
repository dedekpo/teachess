"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { DEFAULT_LANG, parseLang, type Lang } from "./lang";

const LangContext = createContext<Lang>(DEFAULT_LANG);

/** Reads `?lang=` from the URL once per navigation and makes it available to every client component. */
export function LangProvider({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const lang = parseLang(params.get("lang"));
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}
