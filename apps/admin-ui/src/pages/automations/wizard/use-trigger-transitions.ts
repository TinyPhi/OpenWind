import { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../../../lib/api.js";
import { workflowSourceFor } from "./transition-action.js";
import type {
  TransitionOption,
  TransitionsState,
} from "./transition-action.js";

type WorkflowDetail = { transitions?: TransitionOption[] };

async function loadTransitions(
  source: { workflowId: string } | { entityTypeId: string },
): Promise<TransitionOption[]> {
  let workflowId: string | undefined;
  if ("workflowId" in source) {
    workflowId = source.workflowId;
  } else {
    const res = await fetchWithAuth(
      `${API_URL}/workflows?entityTypeId=${encodeURIComponent(source.entityTypeId)}`,
    );
    workflowId = (res as { data?: Array<{ id: string }> }).data?.[0]?.id;
    if (!workflowId) return [];
  }
  const res = await fetchWithAuth(
    `${API_URL}/workflows/${encodeURIComponent(workflowId)}`,
  );
  return (res as { data?: WorkflowDetail }).data?.transitions ?? [];
}

// Transitions of the workflow the trigger pins, fetched only while the rule
// has a transition action.
export function useTriggerTransitions(
  triggerConfig: Record<string, unknown>,
  hasTransitionAction: boolean,
): TransitionsState {
  const source = workflowSourceFor(triggerConfig);
  const sourceKey = source
    ? "workflowId" in source
      ? `w:${source.workflowId}`
      : `e:${source.entityTypeId}`
    : "";
  // Tagged with the source it was loaded for, so a changed trigger never
  // shows the previous workflow's transitions while the new ones load.
  const [loaded, setLoaded] = useState<{
    key: string;
    state: TransitionsState;
  }>({ key: "", state: { status: "loading" } });

  // Keyed on a string, not `source`, which is a new object every render.
  useEffect(() => {
    if (!hasTransitionAction || sourceKey === "") return;
    const id = sourceKey.slice(2);
    const keyed = sourceKey.startsWith("w:")
      ? { workflowId: id }
      : { entityTypeId: id };
    let cancelled = false;
    loadTransitions(keyed)
      .then((transitions) => {
        if (!cancelled) {
          setLoaded({
            key: sourceKey,
            state: { status: "ready", transitions },
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ key: sourceKey, state: { status: "error" } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey, hasTransitionAction]);

  if (!source) return { status: "no-workflow" };
  return loaded.key === sourceKey ? loaded.state : { status: "loading" };
}
