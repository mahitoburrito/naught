import { useEffect } from "react";
import { useCoordinatorAgentStore } from "../stores/useCoordinatorAgentStore";

/**
 * Sets up IPC listeners for coordinator agent state from the Electron main
 * process. Call once in the root App component.
 */
export function useCoordinatorAgentIPC() {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;

    useCoordinatorAgentStore.getState().checkAvailability();

    const onState = (state: any) => useCoordinatorAgentStore.getState()._onState(state);
    const onInteraction = (payload: any) => useCoordinatorAgentStore.getState()._onInteraction(payload);

    api.on("coordinator-agent:state", onState);
    api.on("coordinator-agent:interaction", onInteraction);

    return () => {
      api.removeAllListeners("coordinator-agent:state");
      api.removeAllListeners("coordinator-agent:interaction");
    };
  }, []);
}
