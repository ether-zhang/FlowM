# 结构声明 schema（草案 v0）

> 配合 [structured-refine.md](./structured-refine.md)。这是第 3 步：模型怎么把"这块本该长什么样"
> **声明**出来，框架据此把 B 类后处理**限定作用域**精确实现。等砍。

## 1. 声明格式

引用的是**节点的 mark 号**（模型在图上看到的、文本表 `[n]` 的那个号）。conversation 层把
mark → 真实 id 翻译后交给实现器。箭头不参与（它由端点派生）。

```ts
type Mark = number

type StructureRelation =
  // 流链：自上而下/左右单列推进 → 匀缝 + 近轴吸附
  | { kind: 'flow';       nodes: Mark[]; dir?: 'down' | 'right' }
  // 对齐成行/列：投影到公共轴
  | { kind: 'align';      nodes: Mark[]; axis: 'col' | 'row'; at?: 'min' | 'center' | 'max' }
  // 等尺寸等距网格（行主序，rows 由 count/cols 推出）
  | { kind: 'grid';       nodes: Mark[]; cols: number; gap?: number }
  // 嵌套：children 在 parent 内；父按子长大，子不被推出父界
  | { kind: 'contain';    parent: Mark; children: Mark[] }
  // 互不重叠（限定这组）
  | { kind: 'nonOverlap'; nodes: Mark[] }
  // 原样冻结（手绘/草图，或否决自动推断）
  | { kind: 'freeze';     nodes: Mark[] }

interface StructureDecl { relations: StructureRelation[] }
```

## 2. 关系 → 实现器（B）映射 + 状态

| kind | 实现器（B pass） | 现状 |
|---|---|---|
| `flow` | `normalizeSpacing(scope, dir)` | 已有，**待限定作用域** |
| `nonOverlap` | `resolveOverlaps(scope)` | 已有，**待限定作用域** |
| `align` | 新：投影到公共 x/y | 新增 |
| `grid` | 新：算等距格点坐标 | 新增（取代模型盲吐绝对坐标） |
| `contain` | 新：父长大 + 子裁剪在内 + 仅组内 de-overlap | 新增 |
| `freeze` | 空操作（从所有 B 中排除） | 平凡 |

## 3. 怎么发出 + 校验

- **工具** `declare_structure({ relations })`：模型在**门控轮**（看完首图后）调用，可与纠错
  `move_shape` 等 op **同批**发出。
- **校验** `parseStructure`（纯函数，protocol 层，类比 `parseOp`）：拒绝未知 mark、字段不合法、
  作用域冲突；坏声明丢弃并回报，不阻断其余。
- **marks → ids**：conversation 层翻译（marks 只覆盖节点，正好）。

## 4. 默认 & 冲突（关键语义）

- **自动推断 `flow`**：框架从**箭头链**自动认出流链 → 这些节点默认走 flow（匀缝 + 组内 de-overlap）。
  **流程图因此零模型负担**（和今天行为一致）。
- **其余（无箭头、未声明）→ 冻结**：不被 de-overlap、不被匀。自由/手绘区**默认不受损**
  （修掉今天 `resolveOverlaps` 全局乱推的毛病）。
- **模型声明 = 覆盖/追加**：在自由区声明 `grid`/`contain`/`align`/`nonOverlap` 拿框架帮助；
  在被自动认成 flow 的区声明 `freeze` 来否决（例如带箭头的自由图不想被匀）。
- **一个节点 ≤ 1 个主关系**；多claim 按优先级 `contain > grid > align > flow > nonOverlap > freeze`，
  其余丢弃并 log。

## 5. 例子（套在推理引擎那张图上）

主干 + 两张细节卡 + 算力标注，模型可声明：
```jsonc
{ "relations": [
  { "kind": "flow",  "nodes": [/* 开始..结束 主干节点 */], "dir": "down" },
  // 两张细节卡是主干节点的对称侧挂注释 → 各自和锚节点对齐成行
  { "kind": "align", "nodes": [/* Prefill节点, Prefill细节卡 */], "axis": "row", "at": "center" },
  { "kind": "align", "nodes": [/* Decode节点,  Decode细节卡  */], "axis": "row", "at": "center" },
  { "kind": "freeze","nodes": [/* 🔥算力标注 text */] }
] }
```
→ 框架把 Decode 细节卡从 x=-177 拉回与 Decode 节点同行对称，而算力标注原样不动。

## 6. 分期（重要判断）

**3a 能在不加模型往返的情况下吃下一大半**：只要把 B 类 pass 的作用域从"全局"改成
**箭头连通分量**（= 自动 `flow`），未连通节点冻结——**自由图被乱推的问题当场消除**，
且不需要 `declare_structure`、不需要门控往返。

**3b 才需要门控往返**：`grid`/`contain`/`align` 和"否决自动 flow"这些框架**推不出来**的结构，
要模型看首图后 `declare_structure`。

> 所以建议：先做 **3a（作用域化，纯框架，零往返）**拿掉自由图损伤；再做 **3b（declare_structure
> + 门控）**上富结构。3a 风险小、收益直接，且天然向 3b 演进。

## 7. 暂不做（记着）
- `group`（整体移动/间隔）：MVP 折进 `contain`/`nonOverlap`，按需再拆。
- 跨关系的复杂约束求解（一个节点同时受多关系精确满足）：先靠优先级取一，不上通用求解器。
- 声明的**持久化**：暂为每轮临时（mark 跨轮会变），不存盘。
