# 结构声明 schema（草案 v0）

> 配合 [structured-refine.md](./structured-refine.md)。这是第 3 步：模型怎么把"这块本该长什么样"
> **声明**出来，框架据此把 B 类后处理**限定作用域**精确实现。等砍。

## 1. 声明格式

引用的是**节点 key**：已有节点使用 shape id，新节点使用模型在 create 上声明的 `ref`。
**不用 mark** 的原因：模型可以在节点真正落图前就声明完整结构，不必等渲染出 marks 再来一轮。
FlowM 在同一用户回合维护 `ref → shape id` 注册表：整批 create/connect 先实体化，再解析结构与区域
放置；声明早于 create 出现在前一 build 批次时保持 pending，相关 ref 出现后自动激活。marks 仍只作
**复核图上的视觉索引**（帮模型在图里指认该改哪个）。箭头不参与（由端点派生）。

```ts
type NodeKey = string  // existing shape id | create ref

type StructureRelation =
  // 流链：自上而下/左右单列推进 → 匀缝 + 近轴吸附
  | { kind: 'flow';       nodes: NodeKey[]; dir?: 'down' | 'right' }
  // 对齐成行/列：投影到公共轴
  | { kind: 'align';      nodes: NodeKey[]; axis: 'col' | 'row'; at?: 'min' | 'center' | 'max' }
  // 等尺寸等距网格（行主序，rows 由 count/cols 推出）
  | { kind: 'grid';       nodes: NodeKey[]; cols: number; gap?: number }
  // 嵌套：children 在 parent 内；父按子长大，子不被推出父界
  | { kind: 'contain';    parent: NodeKey; children: NodeKey[] }
  // 互不重叠（限定这组）
  | { kind: 'nonOverlap'; nodes: NodeKey[] }
  // 原样冻结（手绘/草图，或否决自动推断）
  | { kind: 'freeze';     nodes: NodeKey[] }

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

- **工具** `declare_structure({ relations })`：**建图阶段就可调**（模型有已有 id 或新节点 ref），也可在复核轮补声明。
  **由模型自行判断**——有真实结构（链/网格/嵌套）才声明,自由排布**不声明**;不强制 flow。
- **校验** `parseStructure`（纯函数，protocol 层，类比 `parseOp`）：字段/类型不合法即丢弃并回报，
  不阻断其余。id 是否指向真实形状由 `apply` 兜底（只移动场景里实际存在且在 scope 内的形状）。
- 声明的 scope **按整个用户回合累积**（build loop + review），每次 `apply` 都带上，**不是单批次即弃**。
  因为一条 flow 的 `declare_structure`、create 和 `connect_shapes` 可能落在不同 build 批次。ref 在本次
  用户回合内保持有效，框架只在引用全部实体化后激活关系。B 类 pass 只有在**同一次 apply 里 scope 与 edges 同时在场**
  才会拉直，所以授权必须活过单批：留到回合结束，下一批补出边时仍然生效。每次 `send` 开头清空。

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
