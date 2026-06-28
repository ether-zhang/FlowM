# FlowM

## 项目描述

一个用于和大模型双向交互的画布类流程图软件。用户可以在画布上放置或手绘单元发送给大模型；大模型也可以给出文字回复，并通过工具直接调整画布。

## 平台

Windows、macOS、iPad。

## 开发准则

1. 软件栈尽可能多平台通用。
2. git 追踪项目历史，按修改提交 commit。
3. 模块化开发，各功能尽量独立可扩展；尤其核心功能——图形化双向交互——做成独立协议。

## 项目功能

1. **可交互 UI**：主体画布居中；左侧工具栏（初始：方块、画笔、文字）；右侧为与大模型交互的对话栏，可发送「画布部分 + 文字」，也可纯画布或纯文字。
2. **工程持久化**：保留工程上下文；或把接口做好以对接已有 agent（如 claude code、codex）。
3. **用户 → 大模型**：格式化右侧对话栏内容（含画布选区）发送给大模型。
4. **大模型 → 用户**：通过 skill 或脚本等格式化大模型回答，接入自动操纵画布脚本，实现大模型经画布与用户交互。
5. **项目开发能力**：用流程图说明工程结构，大模型解析后开发工程（接已有 agent 最合适）。

## 进度

### 已完成（MVP）

- [x] 可交互 UI 框架：画布（tldraw）+ 内置工具栏（方块/画笔/文字）+ 右侧对话栏
- [x] 核心独立协议层 `protocol/`（画布 ↔ 大模型，provider 无关，含单元测试）
- [x] 用户 → 大模型：序列化画布选区 + 文字发送
- [x] 大模型 → 用户：tool-use 闭环，模型可增删改画布形状、连线
- [x] 工程持久化：保存/加载工程（画布快照 + 对话历史）
- [x] 大模型接入：Poe（OpenAI 兼容接口），provider 中立适配器，dev 经 Vite 代理避开 CORS
- [x] git 追踪、模块化开发

### 待办（TODO）
- UI相关
   - [x] ~~右侧对话框增长影响画布移动逻辑~~ —— 已修复：整壳锁定视口，对话框内部独立滚动
   - [x] Tauri 桌面壳（需先装 Rust；并把模型调用移到 Rust 后端，Key 不入渲染层）—— 已就绪：`src-tauri/` + `TauriAdapter`，Key 存后端、HTTP 由 Rust 发起。Excalidraw 迁移后 `tauri dev` 已实测（窗口/生成/绑定均正常）
     - [x] 打包态字体：Excalidraw 画布字体（Excalifont/Xiaolai-CJK 等）运行时按 `EXCALIDRAW_ASSET_PATH` 取，默认走 CDN → 离线打包会丢。已配：`scripts/copy-excalidraw-fonts.mjs` 在 pre(dev|build) 把字体拷进 `public/fonts`（gitignore），`index.html` 设 `EXCALIDRAW_ASSET_PATH="/"`，离线从 `dist/fonts` 加载
     - [x] `npm run tauri build` 通过：产出 msi / nsis 安装包 + 便携 `src-tauri/target/release/flowm.exe`（前端与字体已内嵌，自包含；依赖系统 WebView2）
     - [ ] 断网实测画布字体不再 fallback（Excalifont / 中文 Xiaolai）—— 当前断网不便，**暂缓**，择机验证；验证通过这条桌面壳才算 Excalidraw 下打包完全坐实
     - 约定：**后续开发/分发以便携 exe 为准**——日常跑 `src-tauri/target/release/flowm.exe`；只想出 exe 不出安装包用 `npm run tauri build -- --no-bundle`。msi/nsis 按需再出
   - [x] Debug模式：看到序列化后的prompt —— 聊天栏 Debug 开关，逐轮折叠展示 system + 历史 + 工具
   - [x] 返回结果的markdown格式解析 —— 助手回复经 react-markdown + remark-gfm 渲染（代码块/列表/表格），用户与系统消息仍为纯文本

- 人机交互相关
    - 自由笔触模式的识别
        - [x] **多模态发送地基**：每次发送把选区「序列化文本 + 选区 PNG 图片」一起发给模型。`CanvasPort.exportImage`（Excalidraw `exportToCanvas`，maxWidthOrHeight=1280）→ `LlmMessage.image` → poe.ts 拼 OpenAI `image_url` content；Tauri 经 Rust `poe_chat` 透传 body，无需改 Rust。system 提示模型据 prompt+图片判断画**流程图**还是**自由排布**（无边记式）。只保留最新一轮图片以控 token；Debug 面板显示所发缩略图。**已确认生效**（模型据图纠错、声明结构、判流程图/自由排布）
        - [x] 模型对自由笔触（draw 手绘）语义的稳定识别/复刻——已能"看到"并据图操作；自由排布（CUDA SM 这类复杂拼块）已能大体组装。下面三条杠杆均落地（见 [docs/structured-refine.md](docs/structured-refine.md)）
            - [x] 杠杆1·视觉锚点（Set-of-Mark）：导出 PNG 前给每个 **NODE** 叠橙色编号徽标（`buildMarkElements`，临时元素只进导出不入实景），序列化文本同步 `[n]` 前缀（`serialize.ts` + `nodeMarks`）。模型据此把图像区域 ground 到真实 shape id（"`[3]` 压住 `[5]`"）。仅标 NODE、连续编号；徽标非真实形状、每轮可变
        - [x] 中心/边界计算脚本+自反馈视觉+涉及组件放置(生成/移动)时进入移动模式更多思考
            - [x] 自反馈视觉做成**显式 refine 门控**（结构化精修）：建图 → 渲首图喂回模型**复核一次** → 模型用 `move_shape` 纠位 / 补 `declare_structure`。详见下「结构化精修门控」与 [docs/structured-refine.md](docs/structured-refine.md)
        - [ ] 让模型在真正布置前划定操作区？操作区在完成前的不可操作？
        - [ ] 流程图 vs 随意排布的自动判别准确度调优（多模态已铺好，靠 prompt + 实测迭代）
    - 结构化精修门控（本期，见 [docs/structured-refine.md](docs/structured-refine.md) / [docs/structure-schema.md](docs/structure-schema.md)）
        - [x] **唯一权威 = 模型声明，框架只实现**：后处理 pass 分两类——**A 不变式**（只动箭头几何：端点绑定/路由/端口，给定拓扑就是唯一解，永远跑）与 **B 意图**（移动/缩放 NODE：消重叠/匀缝，必须**模型授权**才跑、未授权即冻结）。判据「是否动了一个 NODE」。`PassKind` + `INVARIANT_PASSES`/`INTENT_PASSES`（`layoutPasses.ts`），`apply` 只在有 scope 时跑 B、A 恒跑
        - [x] **`declare_structure` 工具**：模型**按 shape id**声明结构关系（flow / align / grid / contain / nonOverlap / freeze），框架据此**限定作用域**精修。仅 flow / nonOverlap 有实现器（`normalizeSpacing` / `resolveOverlaps`），其余解析但暂冻结。纯函数 `parseStructure` / `resolveScope`（`structure.ts`），坏关系丢弃并回报、不阻断
        - [x] **建图→复核门控**：`Conversation.send` = 建图循环（模型边画边可选声明）→ 复核一轮（带 marks 的渲染图喂回，只修 `move_shape` 错位 + 补声明）。复核集 = 本轮新建/改动 + 一跳相连 **∪ 用户选区**（新内容与所展开的图拼在一起）
        - [x] **支撑修复**：① 声明 scope **按整回合累积**（边晚于声明到达也能拉直），但**只在建图阶段**生效——复核的 `move_shape` 不被重排冲掉；② **durable refs**：create-ref 跨批次（限本回合）存活，模型跨回合用 ref 连线不再 `unresolved`；③ `declare_structure` 全程一等公民、每个 tool call 都回 result（杜绝悬空 tool_call → "出错:undefined"）
        - [x] **尺寸=intent、字号=refine 旋钮**：框尺寸是模型意图——`w/h` 改为**可选**（省略才按 label 估默认框），不再撑框覆盖；文字改用 `fitFontSize`**缩字号塞进框**（`labelBoxSize` 逆运算，下限 9px）。治了 SM 那种紧密拼块被撑破列界的重叠
        - [ ] **仍待**：`align`/`grid`/`contain` 实现器（当前解析即冻结）；长回边标签与宽节点的避让；cluster 级避障；箭头几何（focus/offset/路由）仍按整画布重算（O(N²)、跨区可互扰，远距未显形）
    - 布局优化
        - [ ] 未绑定箭头的处理，也许与上两条相互兼容
        - [x] 多输入/输出端点端口分配 + 轻度弯曲：shape 挂多条进/出箭头时全瞄中心 → 挤在同一边界点；改为按对方方位把各边分到周边**不同端口**（focus≠0 求解器 `solveEndpoint`/`determineFocusPoint` 已支持，**写入侧已接** `assignPortFocus`），重合/返回边轻弯错开（`assignParallelOffsets`），label 随各自边走。介于"中心瞄准+单弓"与正交寻路之间；**不做 B 版**（elbow/全局寻路太深）。本质是"否，继续生成"那类标签贴节点问题的根治
            - [x] 同对/反向边分离：`assignParallelOffsets`（按**无序端点对**分组、按规范方向定号使**反向边落两侧**而非同侧）+ `routeBoundArrow` 的 `offset` 在中点垂直起弓（端点对弓点重解、不动点照旧）；port 每批预算各箭头偏移传入 `updateArrow`。治了 `boundary↔buffer` 那种双向箭头+标签重叠（"拼接否截断ken"乱码）。单测 3 例
            - [x] 多端口分配：一个 shape 上**多条不同对**的出/入边按方位分端口 —— 纯函数 `assignPortFocus`（`layout.ts`）：每个 shape 把入射箭头端按出口**侧**（右/下/左/上，按对方方位 90° 扇区）分桶，**≥2 条挤同一侧**才给各端均匀分配小 `focus`（绕 0 对称、按沿边偏角排序使扇形不交叉），独占一侧仍 focus 0（落边中点、轮廓数学最准）；**同对/反向边跳过**（交给 `assignParallelOffsets`，二者不抢同一批箭头）。写入侧已接：`reflowArrow`/`routeBoundArrow` 都吃 `PortFocus`，端点用该 focus 求解、binding 也写同值（不动点不破，nudge 不跳）；新增一条边会触发同侧旧边一起重扇（centre 查找跨全场景 + `arrowsToUpdate` 纳入带非零 focus 的箭头）。**绕障边不算拥挤**：`bowedEdges`（直线中心连线穿第三个框 → 会被 `routeBoundArrow` 弓开、自行分离）从分桶中剔除，否则一条折回的回边会把同侧本该竖直的前向边掰斜（实测 bug）。单测 5 例（独占→0、三条挤一侧落点互异、同对→0、skip 回边不掰斜、bowedEdges 命中/放行）
            - [ ] **仍待**：`focus` step/max 暂定值（0.3/0.6）、未按边数/label 自适应；`offset` 暂定值 48、未按 label 尺寸自适应；offset 路径暂未叠加绕障；diamond/ellipse 侧分桶用 bbox 方位近似
        ~~- [ ] 箭头端点几何自算（edgePoint + computeBoundArrow），也许可以用shape自带初始指明端点优化~~
        - [ ] 提高模型操作画布的精准度，脚本修改大模型返回的xywh，**一个自动避障与优化排布的脚本也许才是这个模块的核心**?
            - [x] 杠杆2·算而不信：把箭头"系统算、不信模型坐标"泛化到布局——纯函数 `resolveOverlaps`（`layout.ts`：仅修**真重叠**、按最小穿透轴推开留 margin、仅作用于本批新建/移动形状，pinned 不动），`apply` 后处理里应用位移并复用 `reflowArrow` 重排受影响箭头。与 `bindingGeometry` 同范式（确定性、留仓库、可测），单测 `layout.test.ts`
        - [ ] 提高画布组件的 UI 拖放精准度，上一条加合理的曲线箭头
            - [x] 曲线箭头（与 58 互补）：避障挪位后直箭头可能穿过第三个形状 → `routeBoundArrow`（`layout.ts`）**仅当直线段与某形状相交时**把箭头"弓"出一个中点绕开（Liang–Barsky 命中测试 + 选最小弓向，单中点非全局寻路），端点由 `solveEndpoint` 对中点求解以保持不动点、`roundness:{type:2}` 平滑；不相交保持直线。`apply` 后处理 reflow→route 串联
            - [ ] UI 拖放精准度（用户手动拖放/吸附）：部分已随原生 Excalidraw 吸附/绑定生效，余下待细化
            - [ ] 进一步：多障碍 / 双向避让 / 全局寻路（本期只做单中点单障碍）
        - [x] 内容驱动的尺寸 + 间距节律归一：先按文本定盒（`labelBoxSize`：行数×行高、最长行宽，CJK≈字号 / ASCII≈0.6×，**只增不减**，菱形/椭圆额外放大，**撑盒围中心生长**——不动模型对齐），再 `normalizeSpacing` **逐边沿箭头方向**把边到边缝归一到目标缝（**默认取模型自己的中位缝**——尺度归模型、节律归框架，不写死常量）——用真实盒厚、**任意方向通用**、近轴方向吸附对齐、回边经 DFS 排除、仅动本批 movable、源锚定。**带标签的斜/横边按标签在箭头方向的投影 `|w·dx|+|h·dy|` 加宽间距**（水平文字越不正交越占缝，文字不被遮）。排在 `resolveOverlaps` 前；纯函数 `layout.ts`，可单测。（合并原 67「按文本定盒长宽」与 ②「间距归一」）
                - **本期修订**：「撑盒围中心生长（只增不减）」已废——它会把模型精确拼好的紧密格子（CUDA SM 表头）撑破列界、互相重叠。改为 **尺寸=模型 intent（`w/h` 可选、给了就冻结）+ `fitFontSize` 缩字号塞进框**（见上「结构化精修门控」）。`labelBoxSize` 仅在模型未给尺寸时供默认框、及作 `fitFontSize` 的内核
            - **原则（已定）：模型与框架分工，框架不捂住模型** —— ①**模型层**始终据「序列化文本 + 图片」给出*它认为合理*的坐标与大小（不偷懒、不被回收）；②**框架层**只在其输出**之上**调优（消重叠/匀节律/绕障/贴标签）。**尺度、方向、原点、拓扑、尺寸下限都归模型**，框架只做一致化与正确性兜底，**不做收走全部坐标的布局引擎**（过激，已否决）。守则：系统提示词永远要模型好好排版（决不"反正脚本会修"）；改善排版优先走**杠杆1（标注图增强模型感知）**而非下游硬补
                - **一句话总纲（已校准）：模型给设计，框架给实现**——宏观（存在什么/大致位置/整体排布/尺度/方向/**尺寸**）信模型、默认冻结；微观才靠框架，且分两类：**不变式几何**（端点/路由，唯一正确解）框架恒算，**意图一致性**（匀缝/对齐/消重叠/字号）框架按声明 scope 兑现。**「算而不信」收窄**：它仅对不变式几何字面成立（出生于箭头端点），**不是整体布局的总纲**；布局是"宏观信模型设计、微观按声明兑现"，而**尺寸本期已改为 intent（信模型）**，不再属于"不信"之列
            - **后处理架构**：已抽象为可插拔 `LayoutPass` 管线（`layoutPasses.ts`）——pass 只对抽象 `PassContext` 编排，**库无关、可 headless 单测**（顺序/行为都测）；port 提供 Excalidraw 实现（boxes/edges/applyMoves/arrowsToUpdate/updateArrow）。**新增后处理（如上色）只实现 `LayoutPass` 接口并入 `DEFAULT_PASSES`，不动编排**。算法纯函数在 `layout.ts`，编排在 `layoutPasses.ts`，库胶水在 port——三层解耦

- step模式与项目开发能力
   - [ ] step模式，需要结合项目功能5，是先打通功能，再接agent?
   - [ ] 项目功能 5：项目开发能力（流程图 → 工程开发，接已有 agent），step模式，图片与流程图双向并行？
   - [ ] 工程持久记忆能力？

- 杂项
   - [ ] 可变的大模型接入口（provider / 模型切换 UI；适配器已就绪）
   - [ ] iPad / PWA 收尾（manifest + service worker）
   - [ ] 上下文优化
     - [ ] 更短id
   - [x] 画布库 tldraw → Excalidraw（MIT，去商用授权风险）；持久化推到 `CanvasPort.serialize/deserialize` 后面 —— 代码+构建+9 单测通过，**待 `npm run dev` 实测画布/箭头绑定**
     - [x] 箭头不生成 bug：`convertToExcalidrawElements` 默认 `regenerateIds:true` 会丢弃我们设的 id → 返回 id 与实际元素不符 → 后续 connect_shapes 全 unresolved。已改 `regenerateIds:false` 固定 id
     - [x] 箭头弯曲异常 / 全指向右 / undo-redo 后才正常：运行时报 `Linear element is not normalized`。根因链：①Excalidraw 运行时要求 `points[0]===[0,0]`，否则 LinearElementEditor 报错、无法编辑；②converter 的 `start/end` 绑定只产出**占位 points**（默认水平）；③即便我自己传 `points[0]=[0,0]`，converter 对**负向**箭头（朝上/朝左）会重置原点到 bbox 左上，又把 `points[0]` 弄歪（所以只有向上的回边那几条报错）。最终方案：**自己算边到边端点**（bbox 射线交点 + GAP）→ 经 converter 建基础元素 → **再用 `getNormalizedPoints` 逻辑强制 `points[0]=[0,0]`**（`normalizeArrow`，直接保证运行时校验的不变量）→ 手工挂 `startBinding/endBinding`（focus=0 对准中心、gap=2）。`edgePoint`/`normalizeArrow` 是纯逻辑；绑定弯曲行为靠运行时验证
     - [ ] 三角形：Excalidraw 无原生三角形，现暂用 diamond 近似，待用闭合三点 line 多边形实现
     - [ ] `update_text` 给原本无标签的容器新增标签（需新建绑定 text 元素 + boundElements 接线）
     - [ ] bundle 瘦身：Excalidraw 拉入 mermaid/katex/cytoscape（多为按需懒加载），评估关闭 TTD/mermaid 特性
- BUG
   - [x] 生成的文字像素级截断（"`_ogits → Softma›`" / "`egister File`"），点一下才正常 —— **字体加载竞态**：标签随 `updateScene` 加入时手写字体 Excalifont 尚未载完，Excalidraw 用 fallback 字体测量+决定换行，渲染时换成真(更宽)字体 → 溢出被裁；Excalidraw 只在字体**未载→已载跃迁**时自动重测、且按字符**子集懒加载**，故"点一下"(nudge) 强制重测才贴正
       - 几番试错（`ensureCanvasFonts` 预载 / 画后 re-dispatch / 画前 `updateScene` 前 load）都未根治，**已回滚**（见 `5c40e54`）。真根因：文字宽度/换行是在 **`convertToExcalidrawElements` 内部**测的，而前几版的 `await font` 都发生在 convert **之后**(updateScene 前) → 测量早已用 fallback
       - **最终修复（`0974239`）**：`apply` 改 async，在 **convert 之前** `await document.fonts.load('20px "Excalifont"', 本批文字)` + Xiaolai —— `FontFaceSet.load(font, text)` 精确加载该串字符所需子集（size 无关，20px 覆盖所有渲染尺寸）。于是首次测量即用真字体，**首帧不裁、无重排闪烁**。调用链 `applyOpCalls→processToolCalls→建图/复核` 全 async 透传
   - [x] 生成的文本只有 `\n` 而没有换行 —— 模型在 JSON 工具参数里把换行**过度转义**成 `\\n`，`JSON.parse` 后是"反斜杠+n"两个字符，Excalidraw 原样渲染（tldraw 时代 `toRichText` 恰好吃掉了所以没暴露）。修复：`decodeText()` 把字面量 `\n`/`\r\n`/`\t` 还原为真字符，作用于 create_geo/create_text/connect_shapes/update_text 的文本（真换行符不匹配该正则、不受影响）。待下次生成实测确认
   - [x] move_shape 后绑定箭头不跟随 —— `updateScene` 绕过 Excalidraw 的绑定重算管线（与箭头注入同类问题），程序化改坐标不触发 `updateBoundElements`。修复：move_shape 记下被移动的 id，后处理里对"绑定到被移动形状的箭头"用 `reflowArrow` 自算边到边端点重排（与初始创建同一套 `edgePoint` 逻辑，不依赖管线）。代价：手动弯折会被拉直（模型移动场景可接受）。用户手动拖动不受影响（Excalidraw 原生管线照常）
     - [x] 箭头压在外框线上 —— `GAP` 2→8，端点离形状边更明显（创建/移动同源，一处改两处生效）
     - [x] 斜向连菱形/椭圆时箭头离形状较远（动一下才贴回）—— 第一版：`edgePoint` 改按 type 求真实边界交点（好了很多但仍有残留漂移，见下）
     - [x] 残留漂移：动一下端点还会跳一点 —— 把原生端点几何按算法**重写为纯函数** `src/canvas/bindingGeometry.ts`（rect/diamond 轮廓按 gap 外扩后逐边求交、ellipse 半轴+gap 解析解、射线从另一端穿 focus 点取最近交点；两端绑定定点迭代）。算法移植自 Excalidraw（MIT，已注明）。但仍有 ~2px 残留，见下
       - 真根因（探针实测确认）：**Excalidraw 才是 focus/gap 的真相源，端点是从它们派生的**。`bindLinearElement→calculateFocusAndGap` 会按几何**反推并存下 focus（常≠0，朝某个角）、gap**；而我固定 focus=0 算几何、移动时又不同步 binding → 不一致。第一次拖动原生用存的 focus(如0.49) 重算 → 端点从我的中心点跳到偏心点（"动一下后正常"正是此）。手画形状默认是**圆角**（`currentItemRoundness:"round"`），focus≠0 把端点推向圆角处，我的直边近似在角上差几十像素（曾"动得更多"）
       - 最终修复：`reflowArrow` 把两端 binding **重置为 focus=0 / gap=8** 并写中心几何（不再沿用存的偏心 focus）。理由：① 中心瞄准使端点落在**边中段、远离圆角**，直边近似在那里零误差；② focus 在移动/微调时不被原生重算（探针证实其值恒定），故写 focus=0 后原生下次也瞄中心 → 复现我的点。探针实测：移动后再手动碰一下，`deltaStart/deltaEnd = {0,0}`（像素级吻合，零跳动）。代价：模型移动会把手画箭头的偏心贴附重置为中心贴附（与模型自建箭头一致，可接受）
       - 单测 `bindingGeometry.test.ts` 8 例（菱形斜向、椭圆在轮廓上、不动点稳定、旋转、focus≠0）；`solveEndpoint` 已支持 focus≠0（为后续"多箭头按边分配"铺路，当前写入恒用 0）。删除旧 `edgePoint`
     - [ ] （已评估放弃）合成 PointerEvent 模拟拖动 / fork 重编译 Excalidraw：前者无程序化拖动 API、pointer-capture 不稳、难 headless 测；后者 monorepo 构建+维护重、软锁定、仍不可测。vendor 纯函数几何已拿到同等保真且可测，故不走
