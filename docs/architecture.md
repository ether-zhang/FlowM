# FlowM Architecture

> Updated on 2026-10-02. Historical decisions and experiments remain in
> [FlowM.md](../FlowM.md); geometry-specific details live in
> [structured-refine.md](structured-refine.md),
> [structure-schema.md](structure-schema.md), and
> [freedraw-and-extensions.md](freedraw-and-extensions.md).

## 1. System boundary

FlowM is a desktop application combining an Excalidraw canvas with project-aware
agents. All model connections use the packaged harness. The stable product contract is not a provider's
wire format. It is:

1. serialize the current canvas and user intent;
2. let an agent return provider-neutral canvas operations;
3. validate and apply those operations through `CanvasPort`;
4. review only the affected region under explicit edit permissions;
5. produce one final explanation.

Dependencies point toward neutral contracts:

```text
app/ + workspace/                         composition and persistence ownership
        |                    |
        v                    v
     engine/              llm/            chat facade and turn orchestration
                              | \
                              |  +-------> harness/        FlowM RPC client
                              v
                           protocol/       canvas operation contract

canvas/ --------------------> protocol/    Excalidraw implementation of CanvasPort
llm/ + harness/ -----------> agent/       neutral question/activity contracts

src/harness/ <-> Tauri supervisor <-> flowm-harness (Rust) <-> pinned Codex core / Responses
```

The enforced rules are:

- `protocol/` imports no outer FlowM layer.
- `agent/` owns provider-neutral question/activity types.
- `harness/` owns FlowM's versioned runtime protocol and imports neither `llm`
  nor UI/engine modules.
- `llm/` may depend on `protocol`, `agent`, and `harness`, but not on
  `engine`, UI, or workspace implementations.
- `canvas/` is the only layer that knows Excalidraw element details.

`src/architecture.test.ts` checks these directions automatically.

## 2. Neutral contracts

### `src/protocol/`

This is the canvas boundary shared by every provider and canvas implementation.

| File | Responsibility |
|---|---|
| `schema.ts` | `CanvasShape`, validated `CanvasOp`, and `OpResult`. |
| `tools.ts` | Provider-neutral operation definitions and JSON Schema. |
| `structure.ts` | Structural declarations and their authorized layout scope. |
| `serialize.ts` | Compact shape text with set-of-mark identifiers. |
| `port.ts` | `CanvasPort`: snapshot, selection, region, apply, image export, persistence. |

Model output is never applied directly. `Conversation` converts tool calls into
`CanvasOp`; `parseOp`/`parseStructure` validate them; only then may `CanvasPort`
change the canvas.

### `src/agent/`

`types.ts` defines provider-neutral user questions, answers, activity events,
and tool statuses. UI, engines, LLM orchestration, and the harness client all
consume these types without depending on a specific control protocol.

Images cross the harness boundary inline. Canvas instructions are supplied by
`Conversation`; adapters no longer write provider guide files into the project.

## 3. Conversation state machine

`src/llm/conversation.ts` owns the complete canvas turn. Adapters do not decide
when to review, finalize, emit the final chat message, or apply tools.

```text
send(userText)
  |
  +-- build (0..8 turns, all canvas tools)
  |     agent operation -> validate -> apply -> return exact result
  |     repeat while the agent emits operations
  |
  +-- review (one turn, only when shapes changed)
  |     render affected region + explicit scope metadata
  |     allowed tools: move_shape, place_region, declare_structure
  |
  +-- finalize (one turn, no tools)
        emit exactly one final explanation
```

Each `RunTurnParams` carries an explicit `phase: build | review | finalize`.
The no-tools finalize schema requires `operations: []`, so a provider cannot
silently continue editing while explaining the result.

### Output envelope

`src/llm/outputContract.ts` compiles one logical output envelope from the active
`ToolDef[]`:

- `portable`: ordinary optional JSON Schema for providers that accept it;
- `strict`: closed objects with nullable placeholders for transports that
  require OpenAI-compatible strict Structured Outputs.

`projectCanvasTurn` removes strict null placeholders and projects both forms to
the same `LlmTurn`. `outputContract.conformance.test.ts` verifies equivalent
operation and question turns across the two profiles.

### Semantic prompt ownership

`Conversation` is the single owner of the canvas behavior contract. It passes
that contract through `RunTurnParams.system`; adapters must forward this value
and must not import or select a provider-specific drawing prompt.

The root diagram command classifies the requested relationships before any
operations are created:

- temporal, execution, lifecycle, and data-movement relationships use a
  top-to-bottom process diagram;
- composition, ownership, hierarchy, peer, and static mapping relationships use
  a structural diagram arranged by those semantics;
- genuinely mixed subjects use separate process and structure regions, each
  following its own rule.

For a structured new diagram, that decision is also emitted as one
`declare_diagram` operation. The declaration contains the diagram kind, exact
focus, semantic regions, and each region's primary/supporting create refs.
`Conversation` parses the declaration before applying any operation in the
batch. A batch that creates shapes and declares layout structure is rejected
atomically when the plan is missing, invalid, or creates an unassigned ref. The
declaration and creates still occupy one provider turn:
FlowM compiles the complete operation array before materialization.
The plan is accepted once per user turn. Before the build phase can finish,
every planned shape ref must resolve to a created or existing canvas id; missing
refs are returned as deterministic build feedback instead of silently accepting
an incomplete declaration.

This plan is an intermediate semantic contract, not model-visible geometry.
The agent still understands the project and chooses concepts; the protocol
states scope and makes that choice observable and testable across providers.
The protocol intentionally does not impose a node quota: primary/supporting
classification is semantic, and detail follows the user request. Supporting
refs are reserved for region containers or essential context, not a way to
hide low-value implementation detail.

OpenAI and gateway use the same `RunTurnParams.system` and strict output contract.
Provider differences are transport encoding concerns, not diagram-selection policy.

Canvas operations use symbolic create refs as their model-facing identity. The
protocol owns pure ref resolution; `Conversation` compiles one logical batch in
two internal stages: create/connect materialisation, then structure and region
placement after refs have concrete canvas ids. A structure declaration may also
precede its creates in an earlier build batch of the same user turn and remains
pending until those refs exist. Adapters and concrete canvas libraries do not
implement provider-specific ref rules.

### Review scope

Review has three separate sets:

- `reviewTargetIds`: shapes changed during the build phase;
- `contextIds`: nearby/connected shapes needed to judge placement;
- `editableIds`: shapes the review is authorized to modify.

Context is visibility, not permission. A review operation targeting a
context-only shape is rejected before it reaches `CanvasPort`. Unrelated distant
content and freehand strokes are not included globally.

## 4. Provider adapters and transports

`LlmAdapter` exposes `runTurn`, optional in-flight question answering, an
optional provider session ID, and optional disposal. `HarnessAdapter` connects
the Conversation state machine and output projection to private, resumable FlowM
threads, inline images, per-turn strict output schema, and the exact caller-owned
canvas system instruction. The old browser/HTTP adapters, API key proxy, and
standalone `Canvas · API` engine have been removed.

`harness/` translates FlowM runtime events into neutral activity,
questions, tool lifecycle events, and final provider output. It does not apply
canvas operations and does not classify build/review/finalize phases.

HarnessAdapter sends only new user/tool feedback and resumes the private kernel
history. Delivery acknowledgement and output validation are separate: completed
input is not sent twice because its JSON was invalid. The service saves a receipt
before native submission and flushes history before completion. A disconnected
client queries that receipt; it never blindly submits the same task again.

### Model selection and discovery

Settings selects one FlowM-owned connection at a time; the session bar selects its model. OpenAI API-key
discovery uses `/v1/models`; ChatGPT discovery uses the plan-aware `models` array
and `visibility: list`. Gateway aliases are explicitly configured, rather than
presented as an OpenAI entitlement catalog. The kernel's bundled metadata is used
for request/tool construction only. Unknown gateway models omit reasoning and
context-window claims until their route is verified. UI language stays in UI files.

## 5. Runtime ownership

`useWorkspace` is the owner of project-scoped local canvas-agent runtimes:

```text
project -> FlowM session -> connection + credential version + role + model -> private thread
```

One runtime is created lazily per binding. Its FlowM harness thread ID is
persisted before its first model request. The runtime is disposed when the
session is deleted, another project is opened, or the workspace unmounts.

There is no projectless harness fallback. Without an open project,
`activeConv()` returns `null`; this prevents a local agent from running with an
ambiguous working directory or permission scope outside the selected
project.

Both Canvas Assistant and Project Agent require an open project and use the
active harness connection. Standalone browser mode is no longer supported.

`harness/` at the repository root is a standalone Rust sidecar. Its private home
is in FlowM's app-data directory, set before Codex's helper dispatch. A home lock
prevents concurrent writers. Config/auth/session discovery never falls back to
the user's `~/.codex`. Secrets are encrypted with AES-256-GCM; per-profile keys
live in FlowM's OS credential namespace. Browser OAuth, refresh, and logout stay
native. The frontend receives account information and status, not OAuth tokens.

Canvas threads combine a read-only managed permission profile, no escalation,
and an immutable tool ceiling. Project threads use workspace-write with explicit
approval responses. This Windows build uses the embedded unelevated restricted
token backend. Unsupported managed backends fail explicitly. The Tauri supervisor
uses bounded queues and a Windows Job Object (process group on Unix), so forced
shutdown includes descendants. Its executable path comes from bundled resources.

Legacy CLI IDs remain in metadata as references. Visible conversation and scene
data remain usable. Explicitly selected, completed standalone Codex histories
can be forked into private storage; importing submits no task and does not read
the source application's auth/config. Switching contexts is blocked during a send,
and sending is blocked while an asynchronous context switch is in progress. Dead
native interactions expire. Interrupted receipts persist a blocked thread state.

## 6. Canvas implementation

`src/canvas/excalidrawPort.ts` implements `CanvasPort`. It converts validated
operations into Excalidraw elements, resolves refs, loads font subsets before
text measurement, applies layout passes, repairs bindings, and updates the
scene once per batch.

The geometry pipeline is split by responsibility:

- `bindingGeometry.ts`: pure bound-arrow endpoint geometry;
- `layout.ts`: pure spacing, overlap, port, and route algorithms;
- `layoutPlan.ts`: compiles measured scene state and `LayoutScope` authorization
  into a canvas-internal `CompiledLayoutPlan`;
- `layoutPreservation.ts`: protects existing alignment, order, containment and
  connector clearance while evaluating proposed node repairs;
- `layoutTrace.ts`: keeps a bounded local history of materialization and repair stages;
- `edgeRouting.ts`: deterministic batch-aware corridor routing and label anchors;
- `layoutPasses.ts`: provider/library-neutral pass orchestration;
- `excalidrawPort.ts`: Excalidraw-specific data conversion and mutation.

The governing rule is **the model chooses the design; the framework implements
declared geometric intent**. Node-moving passes run only inside an explicitly
declared structure scope, and a repair may not destroy the original composition.

`LayoutScope` retains both movement permission and the resolved structure declarations.
Flow order/direction, alignment/grid groups, containment, and explicit freeze survive
across build batches. Freeze vetoes automatic movement. Materialization runs before
intent repair, so new declarations are considered before an older scope can move nodes.
The canvas port measures the live elements and
compiles a `CompiledLayoutPlan` containing the authorized node subsets, adaptive
connector corridors, endpoint focus, container pass-through rules, deterministic
edge order, and label dimensions. A node move invalidates the plan, so routing is
compiled again from settled geometry rather than from stale pre-layout positions.

Spacing only expands insufficient gaps between consecutive declared flow nodes;
cross-region dependency edges do not become flow constraints. It no longer compacts
all gaps to a median or lets a UUID-sorted first parent determine placement. Existing
rows/columns are preserved through equal translations, and moving a container carries
its children only when they are also authorized to move. Existing containment is not
an overlap to eliminate. Recognizing existing geometry adds protection, never permission.

Each proposed movement is checked for permission, original order, containment, new or
worsened overlaps, and reduced connector clearance. A failing proposal is rejected as
a whole. Containers are not silently enlarged. Unresolved conflicts are returned to
Conversation after all tool results have been paired, for explicit model correction.
This is conservative repair, not a complete constraint solver or an align/grid realizer.

Only new/edited edges, edges with moved endpoints, and routes or labels obstructed by
changed shapes are reconsidered. Unaffected routes and labels reserve their existing
space first. Existing clear bends are retained; translating both endpoints translates
the route. Among affected edges, labeled edges run first. Newly computed routes use the
checked line segments directly. An invalid fallback cannot silently replace an existing
route; it retains the prior direction and reports the conflict.

For local diagnosis, `window.__flowmLayout.getTraces()` returns the last eight apply
batches as detached JSON-safe snapshots: operations, resolved declarations, the scene
before/materialized/spacing/overlap/routing, candidate node positions, accepted/rejected
decisions, and diagnostics. `window.__flowmLayout.clear()` clears this memory. Snapshots
are not uploaded or written to project files; export them manually when retaining a repro.

## 7. UI and activity

`engine/` presents provider implementations through `ChatEngine`.
`CanvasEngine` delegates canvas turns to `Conversation`; `HarnessProjectEngine`
attaches selected canvas context to an independent engineering thread without
participating in canvas orchestration.

`chat/` renders neutral messages, questions, reasoning/commentary activity,
tool lifecycle, diagnostics, and final text. It consumes `agent/` types and does
not parse provider wire events.

`app/App.tsx` is the composition root. It selects engines, connects workspace
state to the shell, and maps callbacks into chat display state. Provider parsing,
prompt construction, and canvas operation validation do not belong in App.

## 8. Verification

The required checks for changes to the canvas-agent path are:

```powershell
npm.cmd test -- --run
npm.cmd run build
cargo test --manifest-path src-tauri/Cargo.toml
cd harness
cargo +stable test --locked --offline
cd ..
npm run harness:test
```

Targeted lint should pass for newly added or isolated modules. The repository
still has pre-existing React Compiler lint debt in `App.tsx` and workspace state
mutation patterns; that debt must be fixed as its own scoped change rather than
mixed into provider or canvas behavior work.

## 9. Known boundaries

- The harness preserves public provider events and does not fabricate hidden reasoning.
- Real ChatGPT sign-in, a chosen gateway/Claude route, clean-machine installation,
  and macOS/Linux acceptance remain integration checks. Runtime feature disabling
  does not establish dependency pruning or a small binary.
- Build and review commentary share one activity timeline; clearer phase labels
  remain a presentation task and must not alter model output roles.
- Review is deliberately limited to changed IDs. Moving a larger existing user
  region requires an explicit authorization design rather than widening review
  implicitly.
- Dense diagrams now use deterministic corridor candidates, but routing remains a
  bounded greedy batch rather than a complete global graph optimizer. Further
  quality work belongs in canvas geometry and must not become provider-specific
  prompt or UI patches.
