import { useStore } from "./useStore";
import { useCoordinatorAgentStore } from "./useCoordinatorAgentStore";

/**
 * The right edge has two docks.
 *
 * The *outer* dock is the browser panel. It tiles: both the sidebar and the
 * coordinator read `browserPanelWidth` and offset themselves by it, so the
 * browser sitting alongside either of them is deliberate and stays.
 *
 * The *inner* dock is shared by the sidebar and the coordinator, and holds
 * exactly one of them. Both render at the same `right` with the same top and
 * bottom, so opening both does not tile — the sidebar's z-50 covers the
 * coordinator's z-40 completely. The coordinator stays mounted, keeps polling
 * its snapshot every 1.5s, and the header button still reads as active, with
 * nothing on screen to say so.
 *
 * Opening either panel is done by calling its setter directly from a dozen
 * call sites across the app (the header, the command palette, keyboard
 * shortcuts, the activity center, session selection, terminal links), and the
 * two flags live in different stores. Enforcing the invariant by subscription
 * covers every one of those without either store importing the other, and
 * covers call sites added later.
 */
export function installRightDockExclusion(): () => void {
  // Guards re-entry: closing one panel notifies the other subscription, which
  // would otherwise bounce the close back.
  let settling = false;

  const claimInnerDock = (claim: () => void) => {
    if (settling) return;
    settling = true;
    try {
      claim();
    } finally {
      settling = false;
    }
  };

  const unsubscribeSidebar = useStore.subscribe((state, previous) => {
    if (state.sidebarOpen && !previous.sidebarOpen) {
      claimInnerDock(() => useCoordinatorAgentStore.getState().setPanelOpen(false));
    }
  });

  const unsubscribeCoordinator = useCoordinatorAgentStore.subscribe((state, previous) => {
    if (state.panelOpen && !previous.panelOpen) {
      claimInnerDock(() => useStore.getState().setSidebarOpen(false));
    }
  });

  // Focus mode renders at z-[60] and insets itself only by the browser dock,
  // so it covers the inner dock outright: an open sidebar (z-50) or
  // coordinator (z-40) is behind it, invisible and unclickable, while the
  // coordinator keeps polling. Several call sites already close the sidebar on
  // the way into focus mode; the coordinator was missed. Closing both here
  // makes that hold however focus mode is entered.
  const unsubscribeViewMode = useStore.subscribe((state, previous) => {
    if (state.viewMode !== "focus" || previous.viewMode === "focus") return;
    if (state.sidebarOpen) useStore.getState().setSidebarOpen(false);
    if (useCoordinatorAgentStore.getState().panelOpen) useCoordinatorAgentStore.getState().setPanelOpen(false);
  });

  // Normalise whatever the app started with, in case restored state or an
  // early open left more than one of them set before this ran.
  if (useStore.getState().viewMode === "focus") {
    if (useStore.getState().sidebarOpen) useStore.getState().setSidebarOpen(false);
    if (useCoordinatorAgentStore.getState().panelOpen) useCoordinatorAgentStore.getState().setPanelOpen(false);
  } else if (useStore.getState().sidebarOpen && useCoordinatorAgentStore.getState().panelOpen) {
    useCoordinatorAgentStore.getState().setPanelOpen(false);
  }

  return () => {
    unsubscribeSidebar();
    unsubscribeCoordinator();
    unsubscribeViewMode();
  };
}
