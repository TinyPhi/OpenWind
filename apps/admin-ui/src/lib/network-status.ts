import { API_URL } from "./api.js";
import { subscribeToConnectionState } from "./notifications-client.js";

/**
 * Single source of truth for "is the user offline, or is the server
 * unreachable, or are we fine" — see docs/specs/network-status-awareness.md.
 *
 * navigator.onLine and the notifications socket's open/closed state are
 * HINTS ONLY — they trigger a probe, never set state alone:
 *  - navigator.onLine is unreliable on LAN/VPN-only links, captive portals,
 *    and Firefox's "Work Offline" mode (reports offline with a working link).
 *  - the socket also closes on auth/token-expiry, which is not a network
 *    condition — treating socket-down as truth would show "You're offline"
 *    to a user with a fine connection and an expired token.
 *
 * GET /api/health is the source of truth: no auth, no DB/Redis work on the
 * server side, so a degraded-DB incident is never misreported as "offline".
 */

export type NetworkBannerState =
  | { kind: "offline" }
  | { kind: "reconnecting" }
  | { kind: "recovered" }
  | { kind: "online" };

const PROBE_TIMEOUT_MS = 3_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const DEBOUNCE_MS = 1_500;
const RECOVERED_DISPLAY_MS = 4_000;

let serverReachable = true;
let snapshot: NetworkBannerState = { kind: "online" };
const listeners = new Set<() => void>();

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let recoveredTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let probeInFlight = false;
let started = false;

function emit(next: NetworkBannerState): void {
  snapshot = next;
  for (const l of listeners) l();
}

function clearDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function currentDownKind(): "offline" | "reconnecting" {
  return navigator.onLine === false ? "offline" : "reconnecting";
}

function scheduleRetry(): void {
  clearRetry();
  const delay =
    Math.random() *
    Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retryAttempt);
  retryAttempt += 1;
  retryTimer = setTimeout(() => void probe(), delay);
}

async function probe(): Promise<void> {
  if (probeInFlight || document.visibilityState === "hidden") return;
  probeInFlight = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let ok = false;
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    ok = res.ok && res.status === 200;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
    probeInFlight = false;
  }

  const wasReachable = serverReachable;
  serverReachable = ok;

  if (ok) {
    clearRetry();
    clearDebounce();
    retryAttempt = 0;
    if (!wasReachable) {
      emit({ kind: "recovered" });
      if (recoveredTimer) clearTimeout(recoveredTimer);
      recoveredTimer = setTimeout(
        () => emit({ kind: "online" }),
        RECOVERED_DISPLAY_MS,
      );
    } else {
      emit({ kind: "online" });
    }
    return;
  }

  // A stale "recovered -> online" timer from an earlier brief recovery must
  // not fire later and clobber this new down-state — e.g. server goes down,
  // briefly recovers (arms this timer for +4s), then flaps down again within
  // that window: without clearing here, the timer would still fire ~4s after
  // the ORIGINAL recovery and force-emit "online" while genuinely down.
  if (recoveredTimer) {
    clearTimeout(recoveredTimer);
    recoveredTimer = null;
  }

  scheduleRetry();
  // Debounce ~1.5s before showing a down-state, measured from the FIRST
  // failure — mobile networks blip sub-second constantly on handoff, and a
  // flashing banner is worse than none. Deliberately does not reset on every
  // still-failing retry: a naive clear+reschedule here would push the
  // debounce out indefinitely for as long as retries keep landing inside the
  // window, so the down-state would never actually show during a real outage.
  debounceTimer ??= setTimeout(() => {
    debounceTimer = null;
    if (!serverReachable) emit({ kind: currentDownKind() });
  }, DEBOUNCE_MS);
}

function requestProbe(): void {
  void probe();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") requestProbe();
}

function handlePageShow(): void {
  // Probes on EVERY pageshow, not just BFCache restores (event.persisted):
  // iOS Safari fires pageshow/pagehide more reliably than visibilitychange
  // on app switch, so this is also the primary "became visible again" signal
  // there, not just the BFCache-restore case (where the store is doubly
  // stale — restored page, dead socket).
  requestProbe();
}

function handleConnectionState(state: "open" | "closed"): void {
  // Corroborating hint only — always re-probes rather than trusting the
  // socket's state directly (see module docstring on why).
  if (state === "closed") requestProbe();
}

/** Starts listening. Idempotent — safe to call from multiple subscribers. */
function start(): void {
  if (started) return;
  started = true;
  window.addEventListener("online", requestProbe);
  window.addEventListener("offline", requestProbe);
  window.addEventListener("network:transport-failure", requestProbe);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  subscribeToConnectionState(handleConnectionState);
}

export function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): NetworkBannerState {
  return snapshot;
}
