# FlowM Architecture

> Updated on 2026-10-03. Historical decisions and experiments remain in
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

`CanvasTurnRuntime` exposes FlowM canvas turns, question answering, cancellation,
and disposal. `CanvasTurnProjection` builds the canvas output contract and validates
the returned envelope. It depends on an opaque `HarnessTurnPort`; `HarnessTurn`
owns delivery, inline images, private resumable threads and acknowledged-input cursors.
The exact caller-owned canvas system instruction is preserved. The old browser/HTTP adapters, API key proxy, and
standalone `Canvas · API` engine have been removed.

`harness/` translates FlowM runtime events into neutral activity,
questions, tool lifecycle events, and final provider output. It does not apply
canvas operations and does not classify build/review/finalize phases.

HarnessTurn sends only new user/tool feedback and resumes the private kernel
history. Delivery acknowledgement and output validation are separate: completed
input is not sent twice because its JSON was invalid. The service saves a receipt
before native submission and flushes history before completion. A disconnected
client queries that receipt; it never blindly submits the same task again.

### Model selection and discovery

`HarnessConnections` owns account state, live discovery and the validated model/credential
selection. React subscribes to a single snapshot. Runtime restarts refresh accounts and
models together; delayed results after logout, refresh or credential changes are discarded.
Only model preferences are persisted. `ModelDirectory` is the shared native discovery
service used by both `models/list` and kernel thread creation; authentication is supplied
by `AuthService`. Settings selects one FlowM-owned connection at a time; the session bar selects its model. OpenAI API-key
discovery uses `/v1/models`; ChatGPT discovery uses the plan-aware `models` array
and `visibility: list`. Gateway discovery uses its authenticated `/v1/models`
response (`data[].id`). SIWC starts from the pinned Codex kernel's official candidates,
then live remote metadata overrides matching IDs, including explicit visibility.
Codex's in-process model manager owns picker order, defaults and runtime definitions.
Each model records `origin: remote | kernel`; neither origin asserts account entitlement.
API-key and gateway profiles use only their own discovered IDs. Discovered gateway models omit reasoning and
context-window claims until their route is verified. UI language stays in UI files.

## 5. Runtime ownership

The native harness owns project-scoped logical conversations and durable events:

```text
project -> stable FlowM session -> ordered events / user requests
                              -> credential + role + model execution segment -> private thread
```

`harness/src/sessions.rs` stores append-only JSONL journals with contiguous sequences,
idempotent event IDs and a disk flush before publication. Logical IDs, names and history
survive logout, model selection and credential replacement. Kernel segments resume only
when their credential/role/model/instruction binding and conversation revision match.
Other segments start with provider-neutral historical messages and completed results;
old approval state, provider-encrypted reasoning and queued native tool calls stay isolated.

`HarnessConversations` coordinates a user request across all canvas phases and subscribes
to native events. `useWorkspace` selects projects, canvases and logical conversations;
it does not store thread IDs, choose segments or seed context from UI bubbles.
`Conversation` retains only the current canvas workflow's phase prompts and operation feedback.
UI messages are projections of the native journal, rather than another conversation store.

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

Version 1 workspace conversation records migrate idempotently into the native harness,
preserving IDs, names, visible records and recognizable legacy context. Original files remain
available for rollback; version 2 workspace metadata stores only project/canvas data.
Portable version 2 `.flowm.json` files combine conversation journals with opaque canvas data.
Export/import use bounded pages; unfinished imports remain unpublished and submit no turn.
Legacy version 1 files remain readable. System Codex/Claude history discovery is not used.

Switching contexts is blocked during a send. Startup marks unfinished host workflows as
interrupted and never replays accepted input, tools or canvas operations. Native completed
results reconcile lost receipts only against matching locally owned bindings and input hashes.
Dead interactions expire in the UI projection. Canvas batches are saved atomically before
operation feedback is returned; canvas geometry and protocol remain unchanged.
Deletion removes journal content, bindings, receipts and kernel history, retaining an identity
tombstone so legacy migration cannot resurrect a deleted conversation.

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
state to the shell, and subscribes to harness-owned conversation events.
`chat/sessionProjection.ts` reconstructs display messages from the durable journal. Provider parsing,
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

## Runtime cleanup audit (2026-10-02)

The version 5 handshake requires the caller's validated credential version on thread creation and candidate-origin metadata in `models/list`. Older clients are rejected. Account and gateway candidates and kernel metadata originate from the same native model manager snapshot. Candidate discovery is separate from account authorization. Unknown IDs and explicitly hidden models remain excluded; SIWC models missing from the public directory can use their exact official kernel definitions. Gateway candidates remain limited to that gateway's live directory.

FlowM constrains model metadata to direct tools. Upstream `tool_mode` can override feature switches, so it is normalized alongside the disabled Code Mode/host flags. Legacy API/Claude debug switches, optional activity channels, CLI resume handles and standalone Codex-history import are removed from live execution. Saved FlowM data and private thread resume remain supported. Canvas build/review/finalize and CanvasPort operations are unchanged.

### Live catalog refresh

Discovery uses the pinned Codex `ModelsClient` request construction and raw-response transport, with FlowM-owned authentication and provider routing. OpenAI catalog requests send the schema compatibility `client_version=0.155.0` and no-cache/no-store headers. The pinned source workspace declares `0.0.0`; that build placeholder is not the shipped client compatibility level. A missing version parameter hid GPT-6-Sol and GPT-6-Luna from the returned list. The native catalog TTL cache has been removed; application startup, native-runtime restart and manual refresh fetch current server data. Runtime restarts invalidate UI snapshots. Only the user’s model preference is persisted. There is no manual model-ID entry or directory bypass.

The 2026-10-02 native audit used the existing FlowM SIWC account without exposing OAuth tokens. The public `/v1/models` response contained five visible models with no version, `0.0.0`, `0.153.0` or `0.154.0`; versions `0.155.0`, `0.156.0` and `0.157.0` returned seven. Reusing Codex `ModelsClient` and its default client headers still returned seven. GPT-6.1-Sol was absent from the complete raw responses, rather than hidden by the UI visibility filter. Prior minimal inference probes using the same credentials completed for GPT-6.1-Sol, GPT-6-Sol and GPT-6-Luna; that evidence establishes those requests only, not agent-tool conformance.

Codex’s default discovery instead targets `https://chatgpt.com/backend-api/codex/models` and can use a bundled or cached catalog. Its pinned official catalog contains eight visible models, including GPT-6.1-Sol. SIWC continues to use the public API with FlowM-owned credentials. The official candidate set is kept distinct from the public account directory; kernel-only candidates are not presented as account-authorized models. The server-side reason for omitting GPT-6.1-Sol is not established by client source or published documentation. See [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [Codex catalog guidance](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

### Model interaction ownership review

The application no longer maintains separate profile and catalog hooks or mutates a profile's model field to create runtime bindings. `useHarnessConnection` only subscribes to the harness-owned controller. Workspace code requests role-specific handles through harness factories; binding keys, historical context filtering, model delivery, input acknowledgement, streamed/final text reconciliation and model lifecycle events belong to `src/harness`. Canvas schema validation, build/review/finalize orchestration and CanvasPort execution remain in the domain layer.

Review fixes include rejecting stale credential versions before thread creation, preventing submission after disposal during opening, and distinguishing preparation failure from uncertain delivery. A lost or interrupted submitted request still cannot be automatically replayed. Kernel managers are keyed by normalized model metadata as well as credential, role and model, so a fresh directory response cannot silently reuse an older manager's static capability catalog for a new thread.

`harness/src/provider.rs` owns the application identity, public OpenAI resource and pinned catalog compatibility version. SIWC registration previously used `FlowM` while requests used `flowm_harness`; discovery and inference now use the same `FlowM` identity. A paired native public-catalog check using both identities still returned seven visible models and omitted GPT-6.1-Sol in both complete responses, ruling out this identity mismatch as the explanation for this account's missing directory entry.

Validation: 228 frontend tests across 34 files, 16 native harness tests, TypeScript/Vite build, and local kernel integration with a discovered `claude-offline-fixture` model ID. A loopback test service returns this ID and preset Responses events; it does not run Claude or use Anthropic's native protocol. FlowM harness, the embedded Codex kernel, tools and OS sandbox run normally against that simulated downstream service. Real providers use the same harness path. Canvas, protocol and the canvas system prompt match all 31 protected baseline hashes. Real gateway/Claude inference remains unverified until a gateway is configured.


### Official candidates and access (2026-10-03)

The renewed audit confirmed that the same SIWC credential completes a response whose actual model is gpt-6.1-sol, while the live public directory omits that ID. The former directory-only admission rule caused a false rejection. ModelDirectory now seeds SIWC with codex_models_manager::bundled_models_response, overlays live metadata and delegates picker order, default selection and runtime definitions to StaticModelsManager. Native execution receives the same complete normalized candidate snapshot. No application-owned model-ID list or persisted authorization cache is introduced.

Kernel-only entries use origin: kernel and the picker states that access is confirmed when a request is sent. Gateway and API-key profiles use only remote candidates. Explicit remote hidden/none entries suppress the corresponding official candidate. Provider failures remain failures; another model is never silently substituted.

Validation: 231 frontend tests, 18 native harness tests and 19 local Responses integration requests passed. A real native models/list returned eight candidates including GPT-6.1-Sol, and a native structured turn completed with reply OK and no operations. This validates the fixed native entry path; it does not establish full visual/tool conformance for every model.

### Durable session ownership (2026-10-03)

Protocol version 6 makes the native logical conversation the source of truth. Ownership is now explicit:

| Owner | Responsibility |
| --- | --- |
| Native harness | Conversation CRUD, durable inputs/events/results/images, history, execution segments, credential/role isolation, interruption and native history deletion. |
| Frontend harness | Frozen connection for a user request, RPC coordination, durable framework-event recording, restore subscriptions and paged portable transfer. |
| Canvas framework | Canvas instructions, build/review/finalize, output validation, operation application and saving opaque scene state before feedback. |
| Workspace/UI | Project and canvas selection, legacy source migration, conversation selection and journal-to-display projection. |

Long-term chat history and private kernel IDs have been removed from workspace and App state. Legacy FlowM source files remain intact after migration. Both whole-document and paged imports use the same unpublished transaction and publish only after validation and commit; importing a file executes no task. A changed journal revision invalidates an in-progress export. Native restart ends unfinished workflows as interrupted, while completed-result receipt recovery never authorizes replaying canvas operations from an interrupted parent request.

Validation: 243 frontend tests, 26 native harness tests, 3 desktop-shell tests, scoped ESLint, TypeScript/Vite build and a Windows debug desktop build passed. The local embedded-kernel integration issued 25 Responses requests, covering A→B→A model history, logout/replacement credentials without losing the logical conversation, paged import, forced runtime interruption without inference replay, explicit continuation and isolated deletion. The final import-transaction correction has an additional native regression test. The packaged runtime uses protocol 6 and the unchanged pinned upstream commit. Canvas/protocol directories and the canvas system prompt have no content changes.

This record does not establish a real GPT→Claude gateway exchange: no real gateway was configured. Manual desktop interaction, a release installer, clean-machine operation and other platforms remain separate acceptance checks.

### Gateway provider and OpenRouter acceptance (2026-10-03)

`harness/src/provider.rs` owns connection routing, with parallel `provider/openai.rs` and `provider/gateway.rs` modules. OpenAI owns its SIWC bridge lifecycle; gateways use their configured endpoint and FlowM-managed external auth headers directly. Kernel configuration consumes the provider definition without selecting endpoints itself. Both paths still use the pinned Codex agent loop, permission policy and native session storage; provider IDs are preserved for existing private rollouts.

Gateway metadata maps remote `name`, `context_length`, `top_provider.context_length`, `architecture.input_modalities`, reasoning efforts/default and verbosity support into the same model manager used for the picker and execution. Explicit Codex-native fields take precedence. Unsupported modalities are not advertised to the native kernel, and unknown reasoning efforts retain Codex's own passthrough behavior. A gateway directory remains bounded at 8 MiB and never gains bundled OpenAI candidates. Connecting publishes the active connection only after credential-bound discovery succeeds; errors and late responses after logout do not activate a connection.

OpenRouter's [model directory](https://openrouter.ai/docs/api/api-reference/models/get-models) and [Responses endpoint](https://openrouter.ai/docs/api/api-reference/responses/create-responses) define the downstream format. A public check through the real FlowM runtime returned 466 remote models with gateway-supplied names and submitted zero inference requests. Its temporary home does not read or change the user's FlowM credentials.

Validation: 249 frontend tests, 30 native harness tests, scoped lint and TypeScript/Vite build passed. The embedded kernel completed 27 local Responses requests against an OpenRouter-shaped `/api/v1` fixture, including images, strict JSON, incremental text, model errors over SSE, tool execution, approval, credential isolation, interruption and history continuity. This is not a real Claude inference result. Authenticated OpenRouter requests require the user's API key in FlowM settings; actual model/route tool and visual conformance remains unverified.

### Gateway structured-output compatibility (2026-10-03)

A real OpenRouter Claude route rejected the canvas schema's nullable enums. The original full build contract has 28 union parameters; Claude documents a limit of 16 and does not support the finalize schema's maxItems constraint. The earlier integration used a small hand-written schema and did not cover these compiler restrictions.

The Gateway provider now translates canvas output to a small wire envelope: reply, nullable question, and operations containing op plus arguments_json. Canonical argument definitions remain available in the schema description. The harness parses each arguments_json object, rejects operation overrides and operations outside the phase, and restores the original flat operations before storing the completed result. The host's existing JSON, CanvasOp, ref and review-scope validation remains authoritative. The remote grammar guarantees the envelope; argument syntax and semantics are validated locally before any canvas application. OpenAI sign-in and the canonical schema/CanvasPort definitions are unchanged.

Nested Gateway errors are reduced to the HTTP code and actual provider message without exposing wrapper account metadata. Regression tests now load the real build/review/finalize schemas from the production TypeScript modules, check gateway grammar limits, exercise encoded diagram declarations and verify canonical results. All 34 native tests and 28 local Responses integration requests passed. A real authenticated retry is still needed; local success does not prove the chosen live route has accepted the new schema. See [Claude's structured-output limits](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

### Null schema keyword and terminal-error regression (2026-10-03)

The first Gateway adaptation accidentally inserted enum:null while probing a missing enum with serde_json's mutable index operator. The provider rejected that field because enum must be an array. Optional keywords now use get_mut, which does not insert a missing field. Integration checks validate the types of enum, required, anyOf/allOf/oneOf and properties in the final emitted schema, not only the original host contract. The terminal TurnComplete error path now applies the same message extraction as streamed errors and warnings.

All 35 native tests and 29 local Responses requests passed. The HTTP 400 fixture reproduces the user's nested provider error and verifies that both the RPC error and durable receipt preserve the actual reason without account metadata. Final emitted payloads have no enum:null. This fixes the local regression; live acceptance still requires the user's next explicit retry.

### Engine-directed execution stages (2026-10-03)

Protocol 7 carries runtimePolicy (phase, tool capability and bounded budgets), and thread/open selects toolsDisabled segments. CanvasTurnProjection forwards the existing framework phase. HarnessTurn performs one bounded, plain-text inspection per user request, then requests structured build output with no project tools. Review and finalize also use tool-free segments. Inspection and output retain one logical conversation; the native history seeds the new segment with completed inspection context. Project Agent retains workspace-write and native approvals.

The pinned kernel's startup ToolPolicy is immutable, so tool-free output uses a separate execution segment rather than mutating an existing thread. An extension ModelResponseInterceptor checks generated tool calls before they reach the executor. Inspection permits up to 24 calls, at most two identical calls per request and 32 model responses; output permits no calls and four model responses. Project budgets are bounded separately and detect consecutive repetition. Arguments are hashed rather than logged. Budget or policy failures terminate the request without replay; they do not pretend that the model produced a completed drawing. Model-response interception may reject a response after its HTTP request has already been sent; it is an execution bound, not a promise that inference billing stops before that request.

Validation: 252 frontend tests and 38 native tests passed; 40 local Responses requests exercised actual read commands, shared inspection context, empty project-tool lists for build/review/finalize, execution-before-side-effect rejection, two executions for three identical command requests, total budget enforcement, and existing approval/cancellation/recovery cases. TypeScript/Vite and scoped lint passed. Canvas/protocol and the canvas system prompt are unchanged. Live model behavior still requires a user retry after restarting the protocol-7 runtime.

### Absolute stage timeout replaces call budgets (2026-10-04)

Protocol 8 removes tool-call, repeated-call and model-request counts from runtimePolicy. Every stage now defaults to timeoutSecs:600. One monotonic deadline is established at native execution startup and is shared by model-response interception, turn startup, event collection and completion. Tool activity, streaming tokens and additional model requests never reset it. Phase capability restrictions remain: inspection can use read-only project tools; build/review/finalize advertise none; Project Agent keeps its workspace-write approval boundary.

At expiration the native runtime interrupts the turn, shuts down the execution segment and waits for bounded cleanup before reporting the timeout. The logical conversation and durable interruption record survive. An already-closed segment can be closed or cancelled again safely. Cleanup failure is reported explicitly; neither timeout nor uncertain work is automatically replayed.

Validation: 252 frontend tests, 39 native tests and 41 local Responses requests passed. Tests exercise repeated commands completing within the time limit, continuous stream activity not extending the deadline, a held model stream timing out, no inference replay of the same request, and a running command cancelled before its delayed file write. The one-second integration deadline is a test override; the production default is ten minutes. Canvas/protocol and the canvas system prompt remain unchanged.

### Saved Gateway credentials and publisher ordering (2026-10-04)

Protocol 9 distinguishes a saved Gateway bearer token from an active connection. Disconnect closes bound execution segments and advances the credential version, while retaining the encrypted credential. A native persisted disconnected-gateway set blocks authorization even after restart. Saving the same endpoint reactivates the connection and can reuse its token when the submitted token is omitted. Changing the endpoint or auth kind deletes the old credential. The new auth/forget-gateway-token action removes the encrypted credential and OS key, and leaves the Gateway disconnected. GPT logout continues to remove its credentials.

profiles/list exposes only hasSavedToken and signedIn status. The frontend strips these status fields before saving profiles, never reads a saved token value, and offers an empty-field reuse hint and explicit clear action. Gateway publisher grouping and name sorting are UI projections of the live catalog; upstream IDs, catalog admission, default selection and GPT ordering remain unchanged.

Validation: 258 frontend tests, 39 native tests and 42 local Responses requests passed. The integration verifies retained encrypted credentials, blocked requests while disconnected, restart persistence, reconnection without resubmitting the token, and explicit deletion. TypeScript/Vite, scoped lint and a Windows debug desktop build passed; the packaged harness hash and protocol 9 metadata match. This record does not establish manual desktop interaction or a new authenticated cloud inference result.
