// Traces: BASED-CHAT-UI
// Live activity for the in-flight Capi run — the abbreviated AG-UI event stream shown while the
// agent is working (thinking / calling a tool). Fed from `useAgent`'s `onLifecycleEvent`, which is
// the one hook that fires across every run in a chained turn (run_started, tool_used at tool-call
// start, message_added at text end). Settled tool calls render from `messages` in CapiChat; this
// store only holds the CURRENT run's steps and is reset at each run_started, so the two never
// double-show the same call.
import { create } from "zustand";

export interface LiveStep {
  id: string;
  kind: "thinking" | "tool";
  label: string;
}

type LifecycleEvent =
  | { type: "run_started" }
  | { type: "tool_used"; toolName: string }
  | { type: "message_added"; role: string; content: string };

interface ActivityState {
  steps: LiveStep[];
  onLifecycle(event: LifecycleEvent): void;
  clear(): void;
}

let seq = 0;
const nextId = () => `act_${seq++}`;

export const useActivity = create<ActivityState>((set) => ({
  steps: [],
  onLifecycle(event) {
    switch (event.type) {
      case "run_started":
        // A fresh run (initial or a chained continuation after a tool result). Reset so the strip
        // only ever shows the current run — the prior run's calls are already committed to `messages`.
        set({ steps: [{ id: nextId(), kind: "thinking", label: "Thinking" }] });
        break;
      case "tool_used":
        set((s) => ({ steps: [...s.steps, { id: nextId(), kind: "tool", label: event.toolName }] }));
        break;
      case "message_added":
        // Text arrived — drop a trailing "Thinking" placeholder; the answer renders in the thread.
        set((s) => ({ steps: s.steps.filter((st, i) => !(st.kind === "thinking" && i === s.steps.length - 1)) }));
        break;
    }
  },
  clear() {
    set({ steps: [] });
  },
}));
