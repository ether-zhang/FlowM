# FlowM Architecture

> Updated on 2026-08-23. Historical decisions and experiments remain in
> [FlowM.md](../FlowM.md); geometry-specific details live in
> [structured-refine.md](structured-refine.md),
> [structure-schema.md](structure-schema.md), and
> [freedraw-and-extensions.md](freedraw-and-extensions.md).

## 1. System boundary

FlowM combines an Excalidraw canvas with project-aware local agents and an
OpenAI-compatible API path. The stable product contract is not a provider's
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
                              |  +-------> agentControl/   local transports
                              v
                           protocol/       canvas operation contract

canvas/ --------------------> protocol/    Excalidraw implementation of CanvasPort
llm/ + agentControl/ -------> agent/       neutral question/activity contracts
```

The enforced rules are:

- `protocol/` imports no outer FlowM layer.
- `agent/` owns provider-neutral question/activity types and project artifacts.
- `agentControl/` owns Claude/Codex process protocols and imports neither `llm`
  nor UI/engine modules.
- `llm/` may depend on `protocol`, `agent`, and `agentControl`, but not on
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
and tool statuses. UI, engines, LLM orchestration, and both local transports all
consume these types without depending on a specific control protocol.

`projectFiles.ts` is the single owner of the Tauri commands that write
`.flowm/claude-canvas.md`, `.flowm/codex-canvas.md`, and `.flowm/design.png`.
This keeps project artifact I/O out of provider adapters and chat engines.

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

Claude and Codex may use different project guide filenames and schema profiles,
but the guide contents come from the same `RunTurnParams.system`. Provider
differences are transport encoding concerns, not diagram-selection policy.

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
optional provider session ID, and optional disposal. The implementations share
the Conversation state machine and output projection:

- `PoeAdapter` / `TauriAdapter`: OpenAI-compatible stateless requests;
- `ClaudeAdapter`: Claude Agent SDK control protocol, with a one-shot CLI
  compatibility transport for wrappers that cannot complete the handshake;
- `CodexAdapter`: Codex app-server JSON-RPC and resumable threads.

`agentControl/` translates native process events into neutral activity,
questions, tool lifecycle events, and final provider output. It does not apply
canvas operations and does not classify build/review/finalize phases.

Local adapters send only the new Conversation delta and resume the provider's
own stored session. The canvas guide stays under the active project's `.flowm`
directory and is referenced by a short invocation-scoped instruction. Both
local adapters write the caller-owned `RunTurnParams.system`; neither owns a
provider-specific canvas behavior prompt.

## 5. Runtime ownership

`useWorkspace` is the owner of project-scoped local canvas-agent runtimes:

```text
project -> FlowM session -> { Claude Conversation?, Codex Conversation? }
```

One runtime is created lazily per provider and FlowM session. Its provider
session ID is persisted into project metadata. The runtime is disposed when the
session is deleted, another project is opened, or the workspace unmounts.

There is no projectless Claude/Codex canvas fallback. Without an open project,
`activeConv()` returns `null`; this prevents a local agent from running with an
ambiguous working directory or writing `.flowm` artifacts outside the selected
project.

API mode remains independent and may operate without a local project.

## 6. Canvas implementation

`src/canvas/excalidrawPort.ts` implements `CanvasPort`. It converts validated
operations into Excalidraw elements, resolves refs, loads font subsets before
text measurement, applies layout passes, repairs bindings, and updates the
scene once per batch.

The geometry pipeline is split by responsibility:

- `bindingGeometry.ts`: pure bound-arrow endpoint geometry;
- `layout.ts`: pure spacing, overlap, port, and route algorithms;
- `layoutPasses.ts`: provider/library-neutral pass orchestration;
- `excalidrawPort.ts`: Excalidraw-specific data conversion and mutation.

The governing rule is **the model chooses the design; the framework implements
declared geometric intent**. Invariant arrow geometry always runs. Node-moving
passes run only inside an explicitly declared structure scope.

## 7. UI and activity

`engine/` presents provider implementations through `ChatEngine`.
`CanvasEngine` delegates canvas turns to `Conversation`; legacy build engines
compose project-development prompts without participating in canvas orchestration.

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
```

Targeted lint should pass for newly added or isolated modules. The repository
still has pre-existing React Compiler lint debt in `App.tsx` and workspace state
mutation patterns; that debt must be fixed as its own scoped change rather than
mixed into provider or canvas behavior work.

## 9. Known boundaries

- Claude and Codex expose different public reasoning/commentary event detail;
  FlowM preserves real provider events but does not fabricate hidden reasoning.
- Build and review commentary share one activity timeline; clearer phase labels
  remain a presentation task and must not alter model output roles.
- Review is deliberately limited to changed IDs. Moving a larger existing user
  region requires an explicit authorization design rather than widening review
  implicitly.
- Layout quality and arrow routing still need independent geometry work; they
  must not be corrected by provider-specific prompt or UI patches.
