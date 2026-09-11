"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { LiveTutorClient, type LiveClientConfig, type TutorState } from "./live-client";

export function useLiveTutor(config: LiveClientConfig): { state: TutorState; client: LiveTutorClient } {
  const [client] = useState(() => new LiveTutorClient());

  useEffect(() => {
    client.configure(config);
  });

  useEffect(() => () => client.dispose(), [client]);

  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
  return { state, client };
}
