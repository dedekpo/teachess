import type { Lang } from "./lang";

/** Every string the interface shows, per language. Prompts and chess vocabulary live next to the code that uses them. */
export interface UiStrings {
  setup: { youPlayAs: string; white: string; black: string; professorLevel: string; voice: string; pauseAfter: string; showEngine: string; startLesson: string };
  coach: {
    status: { off: string; connecting: string; live: string; closing: string; idle: string; error: string };
    analyzing: string;
    speaking: string;
    listening: string;
    spokeAfter: (seconds: string) => string;
    billedTime: string;
    micLevel: string;
    holdToTalk: string;
    listeningRelease: string;
    holdSpace: string;
    endLesson: string;
    resumeLesson: string;
    noMic: string;
    holdSpaceHint: string;
    transcriptEmpty: string;
    you: string;
    professor: string;
    events: string;
  };
  badge: { brilliant: string; best: string; excellent: string; good: string; inaccuracy: string; mistake: string; blunder: string };
  moveList: { noMoves: string; best: string };
  evalBar: { evaluation: string };
  gameStatus: { white: string; black: string; checkmate: string; wins: (side: string) => string; draw: string; stalemate: string; threefold: string; fifty: string; insufficient: string; toMove: (side: string) => string; check: string };
  engine: { loading: string; error: (detail: string) => string; idle: string; thinking: string; depth: string };
  promotion: { cancel: string; promoteTo: (piece: string) => string };
  page: { currentPosition: string; positionWhenSaid: string; start: string; restart: string; undo: string; flip: string; soundOff: string; soundOn: string; leaveLesson: string; help: string };
}

export const UI: Record<Lang, UiStrings> = {
  en: {
    setup: {
      youPlayAs: "You play as",
      white: "White",
      black: "Black",
      professorLevel: "Professor level",
      voice: "Voice",
      pauseAfter: "Pause after (s of silence)",
      showEngine: "Show engine on the board",
      startLesson: "Start lesson",
    },
    coach: {
      status: { off: "Lesson ended", connecting: "Connecting…", live: "Live", closing: "Ending…", idle: "Paused (hold Space or make a move to resume)", error: "Error" },
      analyzing: "analyzing…",
      speaking: "speaking",
      listening: "listening to you",
      spokeAfter: (s) => `spoke ${s}s after the move`,
      billedTime: "Billed session time (estimate)",
      micLevel: "Microphone level",
      holdToTalk: "Hold to talk (or hold the space bar)",
      listeningRelease: "Listening… release to stop",
      holdSpace: "Hold Space to talk",
      endLesson: "End lesson",
      resumeLesson: "Resume lesson",
      noMic: "No microphone: you can hear the Professor, but he cannot hear you.",
      holdSpaceHint: "Hold the space bar while you talk to the Professor. The rest of the time the microphone stays closed.",
      transcriptEmpty: "The conversation transcript appears here.",
      you: "You:",
      professor: "Professor:",
      events: "Events",
    },
    badge: { brilliant: "Brilliant move", best: "Best move", excellent: "Excellent move", good: "Good move", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" },
    moveList: { noMoves: "No moves yet.", best: "best" },
    evalBar: { evaluation: "Evaluation" },
    gameStatus: {
      white: "White",
      black: "Black",
      checkmate: "Checkmate",
      wins: (side) => `${side} wins`,
      draw: "Draw",
      stalemate: "Stalemate",
      threefold: "Threefold repetition",
      fifty: "50-move rule",
      insufficient: "Insufficient material",
      toMove: (side) => `${side} to move`,
      check: "Check!",
    },
    engine: { loading: "Loading engine…", error: (d) => `Engine error: ${d}`, idle: "Engine idle", thinking: "Thinking…", depth: "depth" },
    promotion: { cancel: "Cancel promotion", promoteTo: (p) => `Promote to ${p}` },
    page: {
      currentPosition: "Current position",
      positionWhenSaid: "Position when this was said",
      start: "Start",
      restart: "Restart",
      undo: "Undo",
      flip: "Flip",
      soundOff: "Turn move sounds off",
      soundOn: "Turn move sounds on",
      leaveLesson: "Leave lesson mode (back to the free board)",
      help: "Drag or click to move. Right-click a square to highlight it, right-drag to draw an arrow (hold Shift / Alt / Ctrl for other colors). Left-click clears annotations.",
    },
  },
  "pt-BR": {
    setup: {
      youPlayAs: "Você joga de",
      white: "Brancas",
      black: "Pretas",
      professorLevel: "Nível do Professor",
      voice: "Voz",
      pauseAfter: "Pausar após (s de silêncio)",
      showEngine: "Mostrar motor no tabuleiro",
      startLesson: "Iniciar aula",
    },
    coach: {
      status: { off: "Aula encerrada", connecting: "Conectando…", live: "Ao vivo", closing: "Encerrando…", idle: "Em espera (segure Espaço ou jogue para retomar)", error: "Erro" },
      analyzing: "analisando…",
      speaking: "falando",
      listening: "ouvindo você",
      spokeAfter: (s) => `fala ${s}s após o lance`,
      billedTime: "Tempo de sessão cobrado (estimativa)",
      micLevel: "Nível do microfone",
      holdToTalk: "Segure para falar (ou segure a barra de espaço)",
      listeningRelease: "Ouvindo… solte para parar",
      holdSpace: "Segure Espaço para falar",
      endLesson: "Encerrar aula",
      resumeLesson: "Retomar aula",
      noMic: "Sem microfone: você ouve o Professor, mas ele não ouve você.",
      holdSpaceHint: "Segure a barra de espaço enquanto fala com o Professor. No resto do tempo o microfone fica fechado.",
      transcriptEmpty: "A transcrição da conversa aparece aqui.",
      you: "Você:",
      professor: "Professor:",
      events: "Eventos",
    },
    badge: { brilliant: "Lance brilhante", best: "Melhor lance", excellent: "Lance excelente", good: "Bom lance", inaccuracy: "Imprecisão", mistake: "Erro", blunder: "Erro grave" },
    moveList: { noMoves: "Nenhum lance ainda.", best: "melhor" },
    evalBar: { evaluation: "Avaliação" },
    gameStatus: {
      white: "Brancas",
      black: "Pretas",
      checkmate: "Xeque-mate",
      wins: (side) => `${side} vencem`,
      draw: "Empate",
      stalemate: "Afogamento",
      threefold: "Tripla repetição",
      fifty: "Regra dos 50 lances",
      insufficient: "Material insuficiente",
      toMove: (side) => `${side} a jogar`,
      check: "Xeque!",
    },
    engine: { loading: "Carregando o motor…", error: (d) => `Erro do motor: ${d}`, idle: "Motor parado", thinking: "Pensando…", depth: "prof." },
    promotion: { cancel: "Cancelar promoção", promoteTo: (p) => `Promover a ${p}` },
    page: {
      currentPosition: "Posição atual",
      positionWhenSaid: "Posição de quando isso foi dito",
      start: "Começar",
      restart: "Recomeçar",
      undo: "Desfazer",
      flip: "Virar",
      soundOff: "Desligar o som dos lances",
      soundOn: "Ligar o som dos lances",
      leaveLesson: "Sair do modo aula (voltar ao tabuleiro livre)",
      help: "Arraste ou clique para mover. Clique com o botão direito numa casa para destacá-la, arraste com o botão direito para desenhar uma seta (segure Shift / Alt / Ctrl para outras cores). Clique com o botão esquerdo para limpar as anotações.",
    },
  },
};
