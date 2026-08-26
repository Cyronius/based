// Traces: BASED-THEME, BASED-UI-FONT-ZOOM, BASED-LANCE-SEARCH-PROFILES-UI, BASED-AI-PROVIDER-PROFILES,
// BASED-AI-PROFILE-TIMEOUT
// Settings modal (gear icon) mounted in the LeftRail header: General (font-size scale), Theme (color
// theme picker), Search (embedding/reranker profile CRUD), and Agent (AI-provider profile CRUD + agent
// instruction sets) tabs. On the Agent tab, editing a profile or an instruction set takes over the
// whole tab body (the lists are hidden until Save/Cancel returns) to keep the tab uncluttered.
// Presented as a centered modal over a dimmed scrim (same shell as
// ConnectionDialog), with a titled header + close button; the panel has a fixed viewport-relative size
// (min(80vw, 960px) × 85vh) so switching tabs never resizes it, and the tab body scrolls. Selecting a theme applies + persists it via the store; the font-size slider
// applies live on every drag and persists on a trailing debounce (BASED-UI-FONT-ZOOM), so a drag is
// one server write rather than one per tick — Ctrl+wheel and Ctrl+± drive the same store action.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { THEMES, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP, type ThemeDef, type ThemeMode } from "../theme";
import type { AgentInstructionsConfig, AiProfileInput, EmbeddingProfileInput, InstructionSet, ProviderKind, RerankerApi, RerankerProfileInput } from "../api/types";
import {
  getAgentInstructions,
  saveAgentInstructionSet,
  deleteAgentInstructionSet,
} from "../api/client";
import { DEFAULT_AGENT_MAX_STEPS, DEFAULT_AI_TIMEOUT_SECONDS } from "../agent/aiTimeouts";
import { IconButton } from "./IconButton";
import { CopyIcon } from "./icons";

function Swatch({ t }: { t: ThemeDef }) {
  const k = t.tokens;
  return (
    <span className="inline-flex shrink-0 items-center rounded-sm overflow-hidden border border-black/20" style={{ width: 34, height: 16 }}>
      <span style={{ background: k.bg1, width: 12, height: "100%" }} />
      <span style={{ background: k.bg2, width: 10, height: "100%" }} />
      <span style={{ background: k.accent, width: 6, height: "100%" }} />
      <span style={{ background: k.ok, width: 6, height: "100%" }} />
    </span>
  );
}

type Group = "dark" | "midtone" | "light";

const GROUPS: Array<{ id: Group; label: string }> = [
  { id: "dark", label: "Dark" },
  { id: "midtone", label: "Midtone" },
  { id: "light", label: "Light" },
];

function groupOf(t: ThemeDef): Group {
  if (t.tone === "midtone") return "midtone";
  return t.mode as ThemeMode as Group;
}

function GeneralTab() {
  const fontScale = useStore((s) => s.fontScale);
  const setFontScale = useStore((s) => s.setFontScale);
  const explorerTableAction = useStore((s) => s.explorerTableAction);
  const explorerRoutineAction = useStore((s) => s.explorerRoutineAction);
  const setExplorerActions = useStore((s) => s.setExplorerActions);
  const editorKeymap = useStore((s) => s.editorKeymap);
  const setEditorKeymap = useStore((s) => s.setEditorKeymap);

  const selectCls =
    "w-full px-2 py-1.5 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft";

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="ledger-label">Font size</div>
      <input
        type="range"
        min={FONT_SCALE_MIN}
        max={FONT_SCALE_MAX}
        step={FONT_SCALE_STEP}
        value={fontScale}
        onChange={(e) => setFontScale(Number(e.target.value))}
        className="w-full accent-(--color-brass)"
      />
      <div className="flex items-center justify-between text-[length:var(--fs-sm)] text-faint">
        <span>Small</span>
        <span className="text-paper-dim font-mono">{Math.round(fontScale * 100)}%</span>
        <span>Large</span>
      </div>
      {/* Traces: BASED-UI-SHORTCUTS discoverability — the gesture shares this control's action. */}
      <div className="text-[length:var(--fs-sm)] text-faint">Or hold Ctrl and scroll, or press Ctrl+= / Ctrl+- (Ctrl+0 resets).</div>

      {/* Traces: BASED-EDITOR-VIM — modal editing in the query editor; the mode indicator and the
          `:` command line share the app's bottom status bar. */}
      <div className="ledger-label pt-2">Editor keymap</div>
      <select className={selectCls} value={editorKeymap} onChange={(e) => setEditorKeymap(e.target.value as typeof editorKeymap)}>
        <option value="default">Default</option>
        <option value="vim">Vim</option>
      </select>
      <p className="text-faint text-[length:var(--fs-sm)] leading-snug">
        Vim adds modal editing to the query editor. The current mode and the <span className="font-mono">:</span> command
        line appear in the status bar at the bottom; <span className="font-mono">:w</span> saves the tab and{" "}
        <span className="font-mono">:q</span> closes it. F5, Ctrl+Enter, and Ctrl+S keep working in every mode.
      </p>

      {/* Traces: BASED-EXPLORER-ACTION — default double-click behavior in the object explorer. */}
      <div className="ledger-label pt-2">Double-click opens</div>
      <label className="block">
        <span className="text-faint">Tables and views</span>
        <select
          className={`${selectCls} mt-0.5`}
          value={explorerTableAction}
          onChange={(e) => setExplorerActions(e.target.value as typeof explorerTableAction, explorerRoutineAction)}
        >
          <option value="details">Details</option>
          <option value="data">Data</option>
          <option value="sql">SQL</option>
          <option value="script-create">Script as create</option>
        </select>
      </label>
      <label className="block">
        <span className="text-faint">Procedures and functions</span>
        <select
          className={`${selectCls} mt-0.5`}
          value={explorerRoutineAction}
          onChange={(e) => setExplorerActions(explorerTableAction, e.target.value as typeof explorerRoutineAction)}
        >
          <option value="details">Details</option>
          <option value="script-create">Script as create</option>
        </select>
      </label>
    </div>
  );
}

function ThemeTab() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const active = THEMES.find((t) => t.id === theme);
  const [group, setGroup] = useState<Group>(active ? groupOf(active) : "dark");

  const items = THEMES.filter((t) => groupOf(t) === group);

  return (
    <div className="py-2">
      <div className="px-3 pb-2">
        <select
          className="w-full px-2 py-1.5 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft"
          value={group}
          onChange={(e) => setGroup(e.target.value as Group)}
        >
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {items.map((t) => (
        <button
          key={t.id}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-ink-800 ${
            t.id === theme ? "text-brass" : "text-paper-dim"
          }`}
          onClick={() => setTheme(t.id)}
        >
          <Swatch t={t} />
          <span className="flex-1 truncate text-[length:var(--fs-base)]">{t.label}</span>
          {t.id === theme && <span className="text-[length:var(--fs-sm)]">✓</span>}
        </button>
      ))}
    </div>
  );
}

const emptyEmbeddingForm: EmbeddingProfileInput = { name: "", baseUrl: "", model: "", apiKey: "" };
const emptyRerankerForm: RerankerProfileInput = { name: "", baseUrl: "", model: "", apiKey: "", api: "rerank", instruction: "" };

const field =
  "w-full px-2.5 py-1.5 rounded border border-line bg-ink-950 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft placeholder:text-faint";

// One button vocabulary across the whole settings modal: primary (brass), secondary (bordered),
// destructive (red-outline). Reused by every form footer. Add/edit/duplicate row and header
// affordances are IconButtons instead.
const btnPrimary = "rounded bg-brass px-3 py-1 text-ink-950 disabled:opacity-40 disabled:hover:bg-brass";
const btnSecondary = "rounded border border-line px-3 py-1 text-muted hover:text-paper disabled:opacity-40";
const btnDanger = "rounded border border-err/50 px-3 py-1 text-err hover:bg-err/10 disabled:opacity-40";

/** Shared list-row shell for all the CRUD lists (embedding / reranker / AI provider / instruction
 *  set) so they render identically. AI-provider rows pass `onActivate` to become click-to-activate
 *  with an active ✓ marker; embedding/reranker rows omit it (no "active" concept) and are Edit-only.
 *  Instruction-set rows pass `onDuplicate` for a clone-as-new-set affordance. */
function ProfileRow({
  name,
  subtitle,
  active,
  onActivate,
  onEdit,
  onDuplicate,
}: {
  name: string;
  subtitle: string;
  active?: boolean;
  onActivate?: () => void;
  onEdit: () => void;
  onDuplicate?: () => void;
}) {
  const body = (
    <>
      <div className={`truncate flex items-center gap-1.5 ${active ? "text-brass" : "text-paper"}`}>
        <span className="truncate">{name}</span>
        {active && <span className="text-[length:var(--fs-sm)] shrink-0">✓</span>}
      </div>
      <div className="text-faint truncate font-mono">{subtitle}</div>
    </>
  );
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-ink-800">
      {onActivate ? (
        <button className="min-w-0 flex-1 text-left" title="Set active" onClick={onActivate}>
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {onDuplicate && (
        <IconButton title="Duplicate as new set" aria-label="Duplicate as new set" className="shrink-0 text-faint hover:text-brass" onClick={onDuplicate}>
          <CopyIcon />
        </IconButton>
      )}
      <IconButton title="Edit" aria-label="Edit" className="shrink-0 text-faint hover:text-brass" onClick={onEdit}>
        ✎
      </IconButton>
    </div>
  );
}

function SearchProfilesTab() {
  const embeddingProfiles = useStore((s) => s.embeddingProfiles);
  const rerankerProfiles = useStore((s) => s.rerankerProfiles);
  const saveEmbeddingProfile = useStore((s) => s.saveEmbeddingProfile);
  const deleteEmbeddingProfile = useStore((s) => s.deleteEmbeddingProfile);
  const saveRerankerProfile = useStore((s) => s.saveRerankerProfile);
  const deleteRerankerProfile = useStore((s) => s.deleteRerankerProfile);

  const [editingEmbedId, setEditingEmbedId] = useState<string | null>(null);
  const [embedForm, setEmbedForm] = useState<EmbeddingProfileInput>(emptyEmbeddingForm);
  const [editingRerankId, setEditingRerankId] = useState<string | null>(null);
  const [rerankForm, setRerankForm] = useState<RerankerProfileInput>(emptyRerankerForm);

  function startEditEmbed(id: string | "new") {
    if (id === "new") {
      setEmbedForm(emptyEmbeddingForm);
      setEditingEmbedId("new");
      return;
    }
    const p = embeddingProfiles.find((e) => e.id === id);
    if (!p) return;
    setEmbedForm({ ...p, apiKey: "" });
    setEditingEmbedId(id);
  }

  function startEditRerank(id: string | "new") {
    if (id === "new") {
      setRerankForm(emptyRerankerForm);
      setEditingRerankId("new");
      return;
    }
    const p = rerankerProfiles.find((e) => e.id === id);
    if (!p) return;
    setRerankForm({ ...p, apiKey: "" });
    setEditingRerankId(id);
  }

  async function onSaveEmbed() {
    const input = { ...embedForm };
    if (!input.apiKey) delete input.apiKey; // blank on edit = keep the stored key
    await saveEmbeddingProfile(input);
    setEditingEmbedId(null);
  }

  async function onSaveRerank() {
    const input = { ...rerankForm };
    if (!input.apiKey) delete input.apiKey;
    // instruction only means something on the openai api; keep legacy-shaped blobs clean otherwise.
    if (input.api !== "openai" || !input.instruction?.trim()) delete input.instruction;
    await saveRerankerProfile(input);
    setEditingRerankId(null);
  }

  // Traces: BASED-LANCE-RERANK-OPENAI — per-profile API choice; openai mode scores yes/no logprobs
  // via chat completions, so it needs a model id and accepts a task-instruction override.
  const rerankApi: RerankerApi = rerankForm.api ?? "rerank";
  const rerankExtra = (
    <>
      <select className={field} value={rerankApi} onChange={(e) => setRerankForm({ ...rerankForm, api: e.target.value as RerankerApi })}>
        <option value="rerank">Rerank endpoint (Cohere/TEI)</option>
        <option value="openai">OpenAI chat completions (yes/no logprobs)</option>
      </select>
      {rerankApi === "openai" && (
        <input
          className={field}
          placeholder={'Instruction (default: "Given a web search query, retrieve relevant passages that answer the query")'}
          value={rerankForm.instruction ?? ""}
          onChange={(e) => setRerankForm({ ...rerankForm, instruction: e.target.value })}
        />
      )}
    </>
  );

  return (
    <div className="px-3 py-3 space-y-4">
      {/* Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — this tab stays pure CRUD; which profile a
          search uses by default is a property of the connection, set in the connection dialog. */}
      <p className="text-[length:var(--fs-sm)] text-faint leading-snug">
        Endpoints for embedding and reranking. Each LanceDB connection picks which of these it uses by default — edit
        the connection to choose.
      </p>
      <div>
        <div className="ledger-label mb-1.5 flex items-center justify-between">
          <span>Embedding profiles</span>
          <IconButton title="Add embedding profile" aria-label="Add embedding profile" className="mr-2 text-2xl leading-none text-faint hover:text-brass" onClick={() => startEditEmbed("new")}>
            +
          </IconButton>
        </div>
        {embeddingProfiles.length === 0 && editingEmbedId !== "new" && <div className="text-faint italic">None configured.</div>}
        <div className="space-y-1">
          {embeddingProfiles.map((p) =>
            editingEmbedId === p.id ? (
              <ProfileForm
                key={p.id}
                form={embedForm}
                setForm={setEmbedForm}
                modelRequired
                onSave={() => void onSaveEmbed()}
                onCancel={() => setEditingEmbedId(null)}
                onDelete={() => void deleteEmbeddingProfile(p.id).then(() => setEditingEmbedId(null))}
              />
            ) : (
              <ProfileRow key={p.id} name={p.name} subtitle={p.model} onEdit={() => startEditEmbed(p.id)} />
            ),
          )}
          {editingEmbedId === "new" && (
            <ProfileForm
              form={embedForm}
              setForm={setEmbedForm}
              modelRequired
              onSave={() => void onSaveEmbed()}
              onCancel={() => setEditingEmbedId(null)}
            />
          )}
        </div>
      </div>

      <div>
        <div className="ledger-label mb-1.5 flex items-center justify-between">
          <span>Reranker profiles</span>
          <IconButton title="Add reranker profile" aria-label="Add reranker profile" className="mr-2 text-2xl leading-none text-faint hover:text-brass" onClick={() => startEditRerank("new")}>
            +
          </IconButton>
        </div>
        {rerankerProfiles.length === 0 && editingRerankId !== "new" && <div className="text-faint italic">None configured.</div>}
        <div className="space-y-1">
          {rerankerProfiles.map((p) =>
            editingRerankId === p.id ? (
              <ProfileForm
                key={p.id}
                form={rerankForm}
                setForm={setRerankForm}
                modelRequired={rerankApi === "openai"}
                extra={rerankExtra}
                onSave={() => void onSaveRerank()}
                onCancel={() => setEditingRerankId(null)}
                onDelete={() => void deleteRerankerProfile(p.id).then(() => setEditingRerankId(null))}
              />
            ) : (
              <ProfileRow key={p.id} name={p.name} subtitle={p.model || p.baseUrl} onEdit={() => startEditRerank(p.id)} />
            ),
          )}
          {editingRerankId === "new" && (
            <ProfileForm
              form={rerankForm}
              setForm={setRerankForm}
              modelRequired={rerankApi === "openai"}
              extra={rerankExtra}
              onSave={() => void onSaveRerank()}
              onCancel={() => setEditingRerankId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared name/baseUrl/model/apiKey inline form for both embedding and reranker profiles — `model`
 *  is required for embedding profiles, optional for reranker profiles. Blank apiKey on an existing
 *  profile means "keep the stored key" (same convention as ConnectionDialog's secret field). */
function ProfileForm<T extends EmbeddingProfileInput | RerankerProfileInput>({
  form,
  setForm,
  modelRequired,
  extra,
  onSave,
  onCancel,
  onDelete,
}: {
  form: T;
  setForm: (f: T) => void;
  modelRequired?: boolean;
  /** Caller-specific fields (e.g. the reranker API select) rendered between model and API key. */
  extra?: ReactNode;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const editing = !!form.id;
  const canSave = form.name.trim() && form.baseUrl.trim() && (!modelRequired || (form.model ?? "").trim());
  return (
    <div className="border border-line-soft rounded p-2 space-y-1.5 bg-ink-950/40">
      <input className={field} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input
        className={field}
        placeholder="Base URL (e.g. http://localhost:1234/v1)"
        value={form.baseUrl}
        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
      />
      <input
        className={field}
        placeholder={modelRequired ? "Model" : "Model (optional)"}
        value={form.model ?? ""}
        onChange={(e) => setForm({ ...form, model: e.target.value })}
      />
      {extra}
      <input
        type="password"
        className={field}
        placeholder={editing ? "API key (blank = keep stored)" : "API key (optional)"}
        value={form.apiKey ?? ""}
        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
      />
      <div className="flex items-center gap-2 pt-0.5">
        {onDelete && (
          <button className={btnDanger} onClick={onDelete}>
            Delete
          </button>
        )}
        <div className="flex-1" />
        <button className={btnSecondary} onClick={onCancel}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={!canSave} onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  );
}

const emptyAiForm: AiProfileInput = { name: "", kind: "openai-compatible", baseUrl: "", model: "", deployment: "", instructionSetId: "default" };

const PROVIDER_KINDS: Array<{ id: ProviderKind; label: string }> = [
  { id: "openai-compatible", label: "OpenAI-compatible" },
  { id: "openai", label: "OpenAI" },
  { id: "azure-openai", label: "Azure OpenAI" },
  { id: "anthropic", label: "Anthropic" },
];

/** Per-kind base-URL requirements (BASED-AI-PROVIDER-WIRED): required where the endpoint IS the
 *  provider (openai-compatible) or the resource (azure); optional where the provider has a default. */
const KIND_FIELDS: Record<ProviderKind, { urlRequired: boolean; urlPlaceholder: string }> = {
  "openai-compatible": { urlRequired: true, urlPlaceholder: "Base URL (e.g. http://localhost:1234/v1)" },
  "azure-openai": { urlRequired: true, urlPlaceholder: "Endpoint (https://<resource>.openai.azure.com)" },
  openai: { urlRequired: false, urlPlaceholder: "Base URL (optional — provider default)" },
  anthropic: { urlRequired: false, urlPlaceholder: "Base URL (optional — provider default)" },
};

/** AI-provider profile form — same shell as ProfileForm but with a provider-kind select and, for Azure,
 *  a deployment name field; kept separate rather than folded into ProfileForm's generic since the
 *  extra fields don't apply to embedding/reranker profiles. */
function AiProfileForm({
  form,
  setForm,
  sets,
  onSave,
  onCancel,
  onDelete,
}: {
  form: AiProfileInput;
  setForm: (f: AiProfileInput) => void;
  sets: Array<{ id: string; name: string }>;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const editing = !!form.id;
  // Model parameter JSON (BASED-AI-PROFILE-PARAMS): edited as text, synced into form.params only
  // while valid; invalid JSON blocks Save with an inline error.
  const [paramsText, setParamsText] = useState(() => (form.params ? JSON.stringify(form.params, null, 2) : ""));
  const [paramsError, setParamsError] = useState<string | null>(null);
  // Response timeout (BASED-AI-PROFILE-TIMEOUT): edited as text so a half-typed number doesn't get
  // snapped back; anything not a positive number clears the field and the default applies.
  const [timeoutText, setTimeoutText] = useState(() => (form.timeoutSeconds != null ? String(form.timeoutSeconds) : ""));
  function onTimeoutChange(text: string) {
    setTimeoutText(text);
    const n = Number(text.trim());
    const valid = text.trim() !== "" && Number.isFinite(n) && n > 0;
    setForm({ ...form, timeoutSeconds: valid ? Math.floor(n) : undefined });
  }
  // Tool call limit (BASED-AI-PROFILE-STEPCAP): same edited-as-text pattern as the timeout.
  const [stepsText, setStepsText] = useState(() => (form.maxToolSteps != null ? String(form.maxToolSteps) : ""));
  function onStepsChange(text: string) {
    setStepsText(text);
    const n = Number(text.trim());
    const valid = text.trim() !== "" && Number.isFinite(n) && n > 0;
    setForm({ ...form, maxToolSteps: valid ? Math.floor(n) : undefined });
  }
  function onParamsChange(text: string) {
    setParamsText(text);
    if (!text.trim()) {
      setParamsError(null);
      setForm({ ...form, params: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParamsError("must be a JSON object");
        return;
      }
      setParamsError(null);
      setForm({ ...form, params: parsed as Record<string, unknown> });
    } catch {
      setParamsError("invalid JSON");
    }
  }
  const kindFields = KIND_FIELDS[form.kind];
  const azure = form.kind === "azure-openai";
  // Model is optional for openai-compatible: single-model local servers (LM Studio, llama.cpp)
  // run their loaded model when the request carries none; blank means exactly that.
  const modelRequired = form.kind === "openai" || form.kind === "anthropic";
  const canSave =
    form.name.trim() &&
    (!kindFields.urlRequired || form.baseUrl.trim()) &&
    (azure ? (form.deployment ?? "").trim() : !modelRequired || form.model.trim()) &&
    !paramsError;
  return (
    <div className="border border-line-soft rounded p-2 space-y-1.5 bg-ink-950/40">
      <input className={field} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <select
        className={field}
        value={form.kind}
        onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}
      >
        {PROVIDER_KINDS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      <input
        className={field}
        placeholder={kindFields.urlPlaceholder}
        value={form.baseUrl}
        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
      />
      <input
        className={field}
        placeholder={
          azure
            ? "Model (optional — the deployment is what runs)"
            : modelRequired
              ? "Model"
              : "Model (optional — blank uses the server's loaded model)"
        }
        value={form.model}
        onChange={(e) => setForm({ ...form, model: e.target.value })}
      />
      {azure && (
        <input
          className={field}
          placeholder="Deployment name"
          value={form.deployment ?? ""}
          onChange={(e) => setForm({ ...form, deployment: e.target.value })}
        />
      )}
      <input
        type="password"
        className={field}
        placeholder={editing ? "API key (blank = keep stored)" : "API key (optional)"}
        value={form.apiKey ?? ""}
        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
      />
      <label className="block">
        <span className="text-faint">Instructions</span>
        <select
          className={`${field} mt-0.5`}
          value={form.instructionSetId ?? "default"}
          onChange={(e) => setForm({ ...form, instructionSetId: e.target.value })}
        >
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-faint">Response timeout (seconds)</span>
        <input
          type="number"
          min={1}
          className={`${field} mt-0.5`}
          placeholder={`${DEFAULT_AI_TIMEOUT_SECONDS} (default)`}
          value={timeoutText}
          onChange={(e) => onTimeoutChange(e.target.value)}
        />
        <span className="mt-0.5 block text-faint text-[length:var(--fs-xs)]">
          How long the model may stay silent before the chat asks whether to keep waiting. Raise it
          for slow local models; blank uses the default ({DEFAULT_AI_TIMEOUT_SECONDS}s).
        </span>
      </label>
      <label className="block">
        <span className="text-faint">Tool call limit</span>
        <input
          type="number"
          min={1}
          className={`${field} mt-0.5`}
          placeholder={`${DEFAULT_AGENT_MAX_STEPS} (default)`}
          value={stepsText}
          onChange={(e) => onStepsChange(e.target.value)}
        />
        <span className="mt-0.5 block text-faint text-[length:var(--fs-xs)]">
          Tool calls the agent may make in one turn before the chat asks whether to keep going;
          blank uses the default ({DEFAULT_AGENT_MAX_STEPS}).
        </span>
      </label>
      <label className="block">
        <span className="text-faint">
          Model parameters (JSON){paramsError && <span className="text-err"> — {paramsError}</span>}
        </span>
        <textarea
          className={`${field} mt-0.5 min-h-[3.5rem] resize-y font-mono ${paramsError ? "border-err" : ""}`}
          placeholder={'{ "temperature": 0.2, "reasoning_effort": "low" }'}
          value={paramsText}
          onChange={(e) => onParamsChange(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="flex items-center gap-2 pt-0.5">
        {onDelete && (
          <button className={btnDanger} onClick={onDelete}>
            Delete
          </button>
        )}
        <div className="flex-1" />
        <button className={btnSecondary} onClick={onCancel}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={!canSave} onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  );
}

/** List-only view of the AI provider profiles — editing hands off to AiProfileEditor, which takes
 *  over the whole Agent tab (no inline forms mixed into the list). */
function AiProfilesSection({ onEdit }: { onEdit: (id: string | "new") => void }) {
  const aiProfiles = useStore((s) => s.aiProfiles);
  const activeAiProfileId = useStore((s) => s.activeAiProfileId);
  const setActiveAiProfile = useStore((s) => s.setActiveAiProfile);
  // Instruction-set names for the row subtitles (BASED-AI-PROVIDER-PROFILES). Reloaded on mount —
  // the section remounts whenever an editor closes, so freshly created sets show up.
  const [sets, setSets] = useState<Array<{ id: string; name: string }>>([{ id: "default", name: "Default" }]);
  useEffect(() => void getAgentInstructions().then((c) => setSets(c.sets.map((s) => ({ id: s.id, name: s.name })))), []);
  const setName = (id: string) => sets.find((s) => s.id === id)?.name ?? "Default";

  return (
    <div>
      <div className="ledger-label mb-1.5 flex items-center justify-between">
        <span>AI provider profiles</span>
        <IconButton title="Add AI provider" aria-label="Add AI provider" className="mr-2 text-2xl leading-none text-faint hover:text-brass" onClick={() => onEdit("new")}>
          +
        </IconButton>
      </div>
      {aiProfiles.length === 0 && <div className="text-faint italic">None configured.</div>}
      <div className="space-y-1">
        {aiProfiles.map((p) => (
          <ProfileRow
            key={p.id}
            name={p.name}
            subtitle={`${p.model || p.deployment || p.baseUrl} · ${setName(p.instructionSetId)}`}
            active={p.id === activeAiProfileId}
            onActivate={() => void setActiveAiProfile(p.id)}
            onEdit={() => onEdit(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Full-tab editor for one AI provider profile (id "new" = create). Owns the form state and the
 *  instruction-set list for the Instructions dropdown; Save/Cancel/Delete all return to the list
 *  via onClose. */
function AiProfileEditor({ id, onClose }: { id: string | "new"; onClose: () => void }) {
  const aiProfiles = useStore((s) => s.aiProfiles);
  const saveAiProfile = useStore((s) => s.saveAiProfile);
  const deleteAiProfile = useStore((s) => s.deleteAiProfile);
  const [form, setForm] = useState<AiProfileInput>(() => {
    const p = id === "new" ? undefined : aiProfiles.find((e) => e.id === id);
    return p ? { ...p, apiKey: "" } : emptyAiForm;
  });
  const [sets, setSets] = useState<Array<{ id: string; name: string }>>([{ id: "default", name: "Default" }]);
  useEffect(() => void getAgentInstructions().then((c) => setSets(c.sets.map((s) => ({ id: s.id, name: s.name })))), []);

  async function onSave() {
    const input = { ...form };
    if (!input.apiKey) delete input.apiKey; // blank on edit = keep the stored key
    await saveAiProfile(input);
    onClose();
  }

  return (
    <div>
      <div className="ledger-label mb-1.5">{id === "new" ? "New AI provider" : `Edit AI provider — ${form.name || "unnamed"}`}</div>
      <AiProfileForm
        form={form}
        setForm={setForm}
        sets={sets}
        onSave={() => void onSave()}
        onCancel={onClose}
        onDelete={id === "new" ? undefined : () => void deleteAiProfile(id).then(onClose)}
      />
    </div>
  );
}

/** A collapsible textarea box for Core/SQL Server persona/LanceDB persona. The set editor has the
 *  whole tab to itself, so they start open there (`defaultOpen`) but stay collapsible. */
function InstructionsField({
  label,
  value,
  disabled,
  defaultOpen,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  defaultOpen?: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <details className="rounded border border-line" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none px-2 py-1 text-faint">{label}</summary>
      <textarea
        className="w-full resize-y rounded-b border-t border-line bg-ink-950 px-2 py-1 text-paper disabled:opacity-60"
        rows={6}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </details>
  );
}

/** Traces: BASED-AGENT-INSTRUCTIONS — the generated half of the prompt, shown read-only next to the
 *  persona it is injected with. Without it the split is invisible: the user sees a persona that says
 *  nothing about which tools exist and has no way to know that a connection-aware briefing is
 *  already handling it, so they'd write those facts back in by hand — and pin them to whichever
 *  connection they had in mind. */
function BriefingField({ label, value, live }: { label: string; value: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded border border-line-soft bg-ink-950/40" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none px-2 py-1 text-faint">
        {label} <span className="text-[length:var(--fs-xs)]">· generated, not editable{live ? " · this connection" : ""}</span>
      </summary>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-line-soft px-2 py-1 text-[length:var(--fs-sm)] text-muted">
        {value}
      </pre>
    </details>
  );
}

/** Sentinel id for a duplicated-but-not-yet-saved set: it lives only in the editor's `draft` until
 *  Save POSTs it (the id is stripped from the POST), so Cancel simply discards it. Server ids are
 *  UUIDs (or the reserved "default"), so this can't collide. */
const NEW_SET_ID = "new";

/** List-only view of the instruction sets — rows like the profile lists, with a per-row duplicate
 *  affordance. Editing hands off to InstructionSetEditor, which takes over the whole Agent tab. */
function InstructionSetsSection({ onEdit, onDuplicate }: { onEdit: (id: string) => void; onDuplicate: (id: string) => void }) {
  const aiProfiles = useStore((s) => s.aiProfiles);
  const [cfg, setCfg] = useState<AgentInstructionsConfig | null>(null);
  useEffect(() => void getAgentInstructions().then(setCfg), []);
  if (!cfg) return null;

  const subtitle = (s: InstructionSet) => {
    const n = aiProfiles.filter((p) => p.instructionSetId === s.id).length;
    const use = n === 0 ? "unassigned" : n === 1 ? "1 profile" : `${n} profiles`;
    return s.editable ? use : `built-in, read-only · ${use}`;
  };

  return (
    <div>
      <div className="ledger-label mb-1.5">Agent instructions</div>
      <p className="text-faint italic mb-1.5">Author persona sets here; assign one to an agent from its provider profile above.</p>
      <div className="space-y-1">
        {cfg.sets.map((s) => (
          <ProfileRow key={s.id} name={s.name} subtitle={subtitle(s)} onEdit={() => onEdit(s.id)} onDuplicate={() => onDuplicate(s.id)} />
        ))}
      </div>
    </div>
  );
}

/** Full-tab editor for one instruction set. `duplicate` opens an unsaved editable copy of the source
 *  set; the read-only Default set opens as a viewer with a duplicate-to-edit action. Save/Cancel/
 *  Delete all return to the list via onClose. */
function InstructionSetEditor({ id, duplicate, onClose }: { id: string; duplicate?: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<InstructionSet | null>(null);
  const [isNew, setIsNew] = useState(!!duplicate);
  const [busy, setBusy] = useState(false);
  const [briefings, setBriefings] = useState<Record<string, string> | null>(null);
  const engines = useStore((s) => s.engines);
  const [liveEngine, setLiveEngine] = useState<string | null>(null);

  useEffect(() => {
    void getAgentInstructions().then((c) => {
      const source = c.sets.find((s) => s.id === id);
      if (!source) return onClose();
      setDraft(duplicate ? { ...source, id: NEW_SET_ID, name: `${source.name} copy`, editable: true } : source);
      setBriefings(c.briefings ?? null);
      setLiveEngine(c.briefingIsLive ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once for the id this editor opened with
  }, []);

  if (!draft) return null;
  const readOnly = !draft.editable;

  const save = async () => {
    setBusy(true);
    try {
      await saveAgentInstructionSet({
        ...(isNew ? {} : { id: draft.id }),
        name: draft.name,
        core: draft.core,
        personas: draft.personas,
      });
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteAgentInstructionSet(draft.id);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const duplicateToEdit = () => {
    setDraft({ ...draft, id: NEW_SET_ID, name: `${draft.name} copy`, editable: true });
    setIsNew(true);
  };

  return (
    <div className="space-y-2">
      <div className="ledger-label">
        {readOnly ? "View instruction set" : isNew ? "New instruction set" : `Edit instruction set — ${draft.name || "unnamed"}`}
      </div>
      {readOnly ? (
        <p className="text-faint italic">Default instructions are read-only — duplicate to customize.</p>
      ) : (
        <label className="block">
          <span className="text-faint">Name</span>
          <input
            className={`${field} mt-0.5`}
            value={draft.name}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
      )}
      <p className="text-faint">
        A persona sets the agent's voice and working habits. What the connection <em>is</em> — which tools exist, whether it
        accepts writes, how to qualify a table — is generated per connection and always injected alongside whatever you
        write here, so don't restate it (and don't worry about it going stale).
      </p>
      <InstructionsField label="Core (shared)" value={draft.core} disabled={readOnly || busy} defaultOpen onChange={(v) => setDraft({ ...draft, core: v })} />
      {/* One persona + briefing pane per registered engine, in registry order. A new engine gets
          its editor here the moment core registers it — no pane to remember to add. */}
      {engines.map((e) => (
        <Fragment key={e.id}>
          <InstructionsField
            label={`${e.label} persona`}
            value={draft.personas[e.id] ?? ""}
            disabled={readOnly || busy}
            defaultOpen
            onChange={(v) => setDraft({ ...draft, personas: { ...draft.personas, [e.id]: v } })}
          />
          {briefings?.[e.id] && (
            <BriefingField label={`${e.label} capability briefing`} value={briefings[e.id]!} live={liveEngine === e.id} />
          )}
        </Fragment>
      ))}
      <div className="flex items-center gap-2 pt-1">
        {!readOnly && !isNew && (
          <button className={btnDanger} onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
        )}
        <div className="flex-1" />
        <button className={btnSecondary} onClick={onClose} disabled={busy}>
          {readOnly ? "Close" : "Cancel"}
        </button>
        {readOnly ? (
          <button className={btnPrimary} onClick={duplicateToEdit}>
            Duplicate to edit
          </button>
        ) : (
          <button className={btnPrimary} onClick={() => void save()} disabled={busy || !draft.name.trim()}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

/** Which editor (if any) has taken over the Agent tab. While one is open the lists are hidden
 *  entirely — the editor is the tab's whole content until Save/Cancel closes it. */
type AgentEdit = { kind: "profile"; id: string | "new" } | { kind: "set"; id: string; duplicate?: boolean };

function AgentTab() {
  const [editing, setEditing] = useState<AgentEdit | null>(null);
  const close = () => setEditing(null);

  if (editing?.kind === "profile") {
    return (
      <div className="px-3 py-3">
        <AiProfileEditor id={editing.id} onClose={close} />
      </div>
    );
  }
  if (editing?.kind === "set") {
    return (
      <div className="px-3 py-3">
        <InstructionSetEditor key={`${editing.id}:${editing.duplicate ? "dup" : "edit"}`} id={editing.id} duplicate={editing.duplicate} onClose={close} />
      </div>
    );
  }
  return (
    <div className="px-3 py-3 space-y-4">
      <AiProfilesSection onEdit={(id) => setEditing({ kind: "profile", id })} />
      <div className="border-t border-line-soft pt-3">
        <InstructionSetsSection
          onEdit={(id) => setEditing({ kind: "set", id })}
          onDuplicate={(id) => setEditing({ kind: "set", id, duplicate: true })}
        />
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"general" | "theme" | "search" | "agent">("general");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const tabBtn = (id: "general" | "theme" | "search" | "agent", label: string) => (
    <button
      className={`flex-1 px-3 py-1.5 text-[length:var(--fs-sm)] font-bold ${
        tab === id ? "text-brass border-b-2 border-brass" : "text-faint border-b-2 border-transparent hover:text-paper-dim"
      }`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <>
      <IconButton className="text-faint hover:text-brass" title="Settings" aria-label="Settings" onClick={() => setOpen(true)}>
        <GearIcon />
      </IconButton>
      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="w-[min(80vw,960px)] h-[85vh] flex flex-col rounded-lg border border-line bg-ink-900 shadow-2xl shadow-black/50 fade-up">
            <div className="px-5 pt-4 pb-3 border-b border-line-soft flex items-baseline justify-between shrink-0">
              <h2 className="font-display text-lg text-paper">Settings</h2>
              <IconButton title="Close" aria-label="Close" className="text-faint hover:text-paper" onClick={() => setOpen(false)}>
                ✕
              </IconButton>
            </div>
            <div className="flex border-b border-line-soft shrink-0">
              {tabBtn("general", "General")}
              {tabBtn("theme", "Theme")}
              {tabBtn("search", "Search")}
              {tabBtn("agent", "Agent")}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {tab === "general" ? <GeneralTab /> : tab === "theme" ? <ThemeTab /> : tab === "search" ? <SearchProfilesTab /> : <AgentTab />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
