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

- **唯一来源 = 模型视觉声明**：框架**不从几何/箭头自行推断任何结构**（包括 `flow`）。所有 B 类
  重排都由模型看首图后的声明驱动 —— 单一权威，杜绝"框架猜的结构"与"模型看到的结构"打架
  （否决了"按箭头自动 flow"那条捷径：它是第二个结构来源，增变量）。
- **未声明 → 冻结**：不被 de-overlap、不被匀，原样保留。**流程图也要模型声明 `flow` 才会被匀**
  （模型画的它自己知道，负担可接受）；自由/手绘区不声明就天然不受损。
- **代价（已认）**：每次需要 B 精修都走一次**模型视觉往返**（首图→声明）。这是为"单一路径、
  不增变量"付的成本，已确认接受。
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

## 6. 分期（统一单路径）

**不拆"框架自动 flow"那一刀**（已否决：第二个结构来源会与模型声明打架，增变量）。统一走一条路：

1. `declare_structure` 工具 + `parseStructure` 校验（protocol 层，纯函数，可测）；
2. B 类 pass 改为**按声明的作用域**跑（`flow`/`nonOverlap` 限定到声明节点集；未声明 = 冻结）；
3. **门控编排**：首轮 ops → A → 渲首图 → **把首图喂回模型**（复用现有 tool-use 循环的下一轮）
   → 模型回 `declare_structure` + 纠错 ops → B 按声明跑 → A → 终图；
4. 补 `align`/`grid`/`contain` 实现器，靠实测扩。

> 过渡期（门控未上线前）保持现状的全局 B，避免回归；门控上线时**整体替换**，不留半截临时态。

## 7. 暂不做（记着）
- `group`（整体移动/间隔）：MVP 折进 `contain`/`nonOverlap`，按需再拆。
- 跨关系的复杂约束求解（一个节点同时受多关系精确满足）：先靠优先级取一，不上通用求解器。
- 声明的**持久化**：暂为每轮临时（mark 跨轮会变），不存盘。
