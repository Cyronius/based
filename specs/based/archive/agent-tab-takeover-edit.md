# Agent tab: edit mode takes over the tab

Completed in one pass (implemented alongside this plan; archived immediately).

## Problem

The settings Agent tab stacked the AI provider profile list (with inline row-swap edit forms) on
top of an always-visible instruction-set editor (picker + name + three boxes + buttons). With both
sections and an open form visible at once the tab was cluttered and confusing.

## Change

Editing an AI provider profile or an agent instruction set now takes over the entire Agent tab:
the lists are hidden while an editor is open, and Save/Cancel (or Delete) returns to the lists.
Instruction sets became a row list (same `ProfileRow` shell as the other CRUD lists) with per-row
Edit and Duplicate icons; the set editor opens its three persona boxes expanded by default; the
read-only Default set opens as a viewer with a "Duplicate to edit" action.

All in `ui/src/components/ThemePicker.tsx`: `AgentTab` owns the mode, new `AiProfileEditor` /
`InstructionSetsSection` / `InstructionSetEditor` components; `AiProfilesSection` became list-only.

## Spec impact

- **Modified:** `BASED-AGENT-INSTRUCTIONS-UI` (manual) — rewritten from the "Editing set" picker
  design to the row-list + full-tab-takeover editor design; acceptance criteria updated.
- **Touched:** `BASED-AI-PROVIDER-PROFILES` verification procedure step 1 notes the form takes over
  the tab (behavioral CRUD requirements unchanged).
- No core/API changes; `BASED-AGENT-INSTRUCTIONS` untouched.
