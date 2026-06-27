# FlowM 架构与代码回顾（按功能）

> 截至 **v0.5**。本文按功能纵向走查代码，配合 [structured-refine.md](structured-refine.md)（精修门控设计）与 [structure-schema.md](structure-schema.md)（结构声明 schema）。
> 演进细节与历史 bug 见根目录 [FlowM.md](../FlowM.md) 的进度清单。

## 1. 一句话与分层

FlowM 是一个**和大模型双向交互的画布软件**：用户在无限画布上放置/手绘单元发给模型，模型既能文字回复、又能通过工具直接改画布。核心是一条**库无关、provider 无关**的图形交互协议。

三层解耦，依赖**单向向内**（`canvas`/`llm` → `protocol`，protocol 不反向依赖）：

```
┌─────────────┐   tool-use 循环、门控编排      ┌──────────────┐
│   llm/      │ ─────────────────────────────▶ │  protocol/   │  纯类型 + 纯函数
│ Conversation│   (CanvasPort 抽象、CanvasOp)   │  (核心协议)   │  无 Excalidraw / 无 LLM
└─────┬───────┘                                └──────▲───────┘
      │ CanvasPort 接口                                │ 实现 CanvasPort
      ▼                                                │
┌─────────────┐   Excalidraw 胶水 + 纯几何/布局算法   │
│   canvas/   │ ──────────────────────────────────────┘
│excalidrawPort│  bindingGeometry / layout / layoutPasses（均纯函数、可 headless 测）
└─────────────┘
```

**贯穿原则**：
- **算而不信**：不信任模型给的几何（端点、重叠、尺寸），框架在其输出**之上**做一致化与正确性兜底——但**不收走全部坐标**（拒绝做完整布局引擎）。
- **模型拥有 intent，框架只精修**：尺度/方向/拓扑/放置/尺寸下限归模型；一致性（匀缝/对齐/避障/路由/字号适配）归框架。
- **三层纯度**：纯算法（`layout.ts`/`bindingGeometry.ts`）/ 纯编排（`layoutPasses.ts`）/ 库胶水（`excalidrawPort.ts`）分离，前两者 headless 单测。

---

## 2. 协议层 `src/protocol/`

provider/库都无关，是「画布 ↔ 模型」的契约。

| 文件 | 职责 |
|---|---|
| `schema.ts` | `CanvasShape`（读回给模型的形状）、`CanvasOp`（模型发的操作原语，zod 判别联合）、`OpResult`、`parseOp`。`create_geo` 的 `w/h` **可选**（省略=模型没定尺寸，port 补默认；给了=intent 冻结）。 |
| `tools.ts` | provider 中立的工具定义（每个 op 一个 + `declare_structure`），JSON Schema。适配器转成各家 wire 格式。 |
| `structure.ts` | 结构声明：`StructureRelation`（flow/align/grid/contain/nonOverlap/freeze，**按 shape id**）、`parseStructure`（坏的丢弃并回报）、`resolveScope`（→ 哪些 NODE 准被 spacing/overlap pass 移动）。 |
| `serialize.ts` | `formatCanvas`：把形状列表压成给模型的文本，带 `[n]` set-of-mark 前缀。 |
| `port.ts` | **`CanvasPort` 接口**——协议/LLM 层只认它，不认 Excalidraw。`snapshot`/`selectionScope`/`apply`/`exportImage`/`serialize`/`deserialize`。`apply` 返回 `Promise`（字体子集需 await）。 |

---

## 3. LLM 层 `src/llm/`

| 文件 | 职责 |
|---|---|
| `conversation.ts` | **核心编排**：`Conversation.send` 跑一轮用户交互的 tool-use 循环 + 精修门控。 |
| `adapter.ts` / `poe.ts` / `tauriAdapter.ts` | provider 中立适配器接口 + Poe（OpenAI 兼容）实现 + Tauri（Key 走 Rust 后端）。 |
| `types.ts` | `LlmMessage` / `LlmToolCall` 等中立类型（含多模态 `image`）。 |

### 一次 `send` 的全过程（门控）

```
send(userText, port):
  turnScope=null; refMap.clear()                    # 回合状态归零
  selection = port.selectionScope()                 # 记下用户选区（供复核拼图）
  context = formatCanvas(snapshot('selection'))      # 文本 + 选区 PNG
  ── 建图循环 runBuildLoop ──────────────────────────
    while 模型还在调工具:
      processToolCalls(persistScope=true):
        拆出 opCalls / declareCalls
        declareCalls → parseStructure → 累积进 turnScope（按整回合）
        resolveCrossBatchRefs(opCalls)               # 跨批次 ref → 真 id（durable refs）
        port.apply(ops, turnScope)                   # A 恒跑；有 scope 才跑 B
  ── 复核一轮 reviewGate ────────────────────────────
    渲染「本轮新建/改动 + 一跳相连 ∪ 用户选区」带 marks 的图，喂回模型
    模型只 move_shape 纠位 / 补 declare_structure
    processToolCalls(persistScope=false)             # 复核只认当轮新声明，不冲掉手动修正
```

关键状态（均**限本回合**，`send` 开头清空）：
- **`turnScope`**：累积的结构作用域。一条 flow 的声明与它的边常落在不同批次，授权必须活过单次 `apply`——但**只在建图阶段**生效，复核的 `move_shape` 不被重排覆盖。
- **`refMap`**：create-ref → 真 id。模型跨回合用 `ref` 连线时重写成 id，根治 `unresolved`。同批新建的 ref 由 port 本地解析、不被重写。

### Set-of-Mark（视觉锚点）
`nodeMarks` 给每个 NODE（非箭头）连续编号；`serialize` 加 `[n]` 文本前缀；`exportImage` 叠橙色编号徽标。模型据此把图像区域 ground 到真实 id。

---

## 4. 画布层 `src/canvas/`

唯一认识 Excalidraw 的地方。

### 4.1 `excalidrawPort.ts`（库胶水）
实现 `CanvasPort`。要点：
- **`apply(ops, scope)`**（async）：解析 ops → 建 skeleton/连接 → **convert 前 `await` 字体子集**（见 §5 字体）→ `convertToExcalidrawElements`（`regenerateIds:false` 固定 id）→ 建箭头（绑定/非绑定）→ 跑后处理 pass（有 scope 跑 B、A 恒跑）→ 一次 `updateScene`。
- **`snapshot` / `selectionScope` / `exportImage`**：选区按**区域**（选中形状包围盒内全部，`selectionRegion`）而非仅选中形状；导出可叠 marks。
- **箭头几何**：`computeBoundArrow` / `reflowArrow` / `routeArrowElement` 调纯函数算端点与路由，`normalizeArrow` 保证 `points[0]=[0,0]`（否则 Excalidraw 运行时报错不可编辑）。

### 4.2 `bindingGeometry.ts`（纯几何，移植自 Excalidraw MIT）
`updateScene` 不触发原生绑定管线，故把原生端点几何**重写成纯函数**：`solveEndpoint`（rect/diamond 轮廓按 gap 外扩逐边求交、ellipse 解析解、射线从另一端穿 focus 取最近交点）、`solveArrowEndpoints`（两端绑定定点迭代）。同套数学=同等保真，可单测、不背 fork 负担。

### 4.3 `layout.ts`（纯布局算法）
- `resolveOverlaps`：仅修真重叠、最小穿透轴推开、只动 movable。
- `normalizeSpacing`：逐边沿箭头方向把边到边缝归一（默认取模型中位缝）、近轴吸附、DFS 排回边。
- `labelBoxSize` / **`fitFontSize`**：前者按文本估盒；后者是其**逆运算**——给定框反解能塞下的最大字号（下限 9），实现「尺寸=intent、缩字适配」。
- `assignPortFocus` / `assignParallelOffsets` / `bowedEdges` / `routeBoundArrow`：多端口分配、同对/反向边分离、绕障单弓。

### 4.4 `layoutPasses.ts`（纯编排）
`LayoutPass` 接口 + `PassContext`（port 提供 Excalidraw 实现）。**`PassKind`**：
- **`invariant`（A）**：只动箭头几何（`arrowPass`）——给定拓扑是唯一解，**恒跑**。
- **`intent`（B）**：移动/缩放 NODE（`spacingPass`/`avoidPass`）——须模型声明授权、限定 scope，否则冻结。
新增后处理（如上色）只实现接口并入列表，不动编排。

---

## 5. 横切关键点

- **字体加载竞态**：文字宽度/换行在 `convertToExcalidrawElements` **内部**测；字体未载完→fallback 测量→真字体更宽→裁，且 Excalidraw 按子集懒加载、只在字体跃迁时自动重测。**修复**：convert **之前** `await FontFaceSet.load('20px "Excalifont"', 本批文字)`（+Xiaolai），精确载入该串字符子集，首帧即正确。（试错与回滚史见 FlowM.md BUG 区）
- **三层纯度即可测**：`protocol.test.ts` / `layout.test.ts` / `layoutPasses.test.ts` / `bindingGeometry.test.ts`，当前 **67 例**，`npm test`（vitest）。算法/编排不碰 DOM。
- **持久化**：`CanvasPort.serialize/deserialize` 把画布存取做成不透明值，持久层（`persistence/`）只round-trip，不绑某画布库。
- **桌面壳**：Tauri，Key 存 Rust 后端、HTTP 由 Rust 发起，渲染层不见明文 Key。

---

## 6. 模块速查

```
src/
  protocol/   schema · tools · structure · serialize · port   (纯, 库/LLM 无关)
  llm/        conversation(门控) · adapter · poe · tauriAdapter · types
  canvas/     excalidrawPort(胶水) · bindingGeometry · layout · layoutPasses · Canvas.tsx
  persistence/ project (工程存取)
  app/        App.tsx (装配)
docs/         architecture(本文) · structured-refine · structure-schema
```

## 7. 已知边界 / 下一步

- 结构声明 `align`/`grid`/`contain` 暂解析即冻结，无实现器。
- 箭头几何（focus/offset/路由）仍按整画布重算（O(N²)、跨区可互扰，远距未显形）——待限定 region。
- 长回边标签与宽节点避让、多障碍/全局寻路未做（本期单中点单障碍）。
- 项目功能 5（流程图 → 工程开发，接 agent）、step 模式、provider 切换 UI、iPad/PWA 收尾。
