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
        - [x] **多模态发送地基**：每次发送把选区「序列化文本 + 选区 PNG 图片」一起发给模型。`CanvasPort.exportImage`（Excalidraw `exportToCanvas`，maxWidthOrHeight=1280）→ `LlmMessage.image` → poe.ts 拼 OpenAI `image_url` content；Tauri 经 Rust `poe_chat` 透传 body，无需改 Rust。system 提示模型据 prompt+图片判断画**流程图**还是**自由排布**（无边记式）。只保留最新一轮图片以控 token；Debug 面板显示所发缩略图。**待运行时确认 Poe/Claude 视觉是否真生效**
        - [ ] 模型对自由笔触（draw 手绘）语义的稳定识别/复刻——现已能"看到"（图片入参），但理解与执行待打磨，提醒结合图片与实际坐标？
            - [ ] 杠杆1·视觉锚点（Set-of-Mark）：导出前在 PNG 上叠加每个 shape 的 id 徽标 + 场景坐标网格/原点轴，把"图↔序列化坐标"对应关系**直接画出来**而非靠模型脑补（纯提示词太薄）；在 `exportImage` 内做，映射 `px=(scene-bboxMin+padding)*scale` 单测先行。VLM grounding 成熟手法，确定性可测。提示词只是它的说明书
        - [ ] 中心/边界计算脚本+自反馈视觉+涉及组件放置(生成/移动)时进入移动模式更多思考
            - [ ] 自反馈视觉做成**显式 refine 模式**（应用后重渲染→喂回让模型挑错），默认关、控成本/延迟，不做默认每轮
        - [ ] 让模型在真正布置前划定操作区？操作区在完成前的不可操作？
        - [ ] 流程图 vs 随意排布的自动判别准确度调优（多模态已铺好，靠 prompt + 实测迭代）
    - 布局优化
        - [ ] 未绑定箭头的处理，也许与上两条相互兼容
        - [ ] 同一 shape 多条出口箭头按边分配（focus≠0；`solveEndpoint`/`determineFocusPoint` 已支持，写入侧待接）
        ~~- [ ] 箭头端点几何自算（edgePoint + computeBoundArrow），也许可以用shape自带初始指明端点优化~~
        - [ ] 提高模型操作画布的精准度，脚本修改大模型返回的xywh，**一个自动避障与优化排布的脚本也许才是这个模块的核心**?
            - [x] 杠杆2·算而不信：把箭头"系统算、不信模型坐标"泛化到布局——纯函数 `resolveOverlaps`（`layout.ts`：仅修**真重叠**、按最小穿透轴推开留 margin、仅作用于本批新建/移动形状，pinned 不动），`apply` 后处理里应用位移并复用 `reflowArrow` 重排受影响箭头。与 `bindingGeometry` 同范式（确定性、留仓库、可测），单测 `layout.test.ts`
        - [ ] 提高画布组件的 UI 拖放精准度，上一条加合理的曲线箭头
            - [x] 曲线箭头（与 58 互补）：避障挪位后直箭头可能穿过第三个形状 → `routeBoundArrow`（`layout.ts`）**仅当直线段与某形状相交时**把箭头"弓"出一个中点绕开（Liang–Barsky 命中测试 + 选最小弓向，单中点非全局寻路），端点由 `solveEndpoint` 对中点求解以保持不动点、`roundness:{type:2}` 平滑；不相交保持直线。`apply` 后处理 reflow→route 串联
            - [ ] UI 拖放精准度（用户手动拖放/吸附）：部分已随原生 Excalidraw 吸附/绑定生效，余下待细化
            - [ ] 进一步：多障碍 / 双向避让 / 全局寻路（本期只做单中点单障碍）
        - [ ] 模型生成组件时根据文本行数和最长行决定组件长与宽。

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
   - [x] 生成的文本只有 `\n` 而没有换行 —— 模型在 JSON 工具参数里把换行**过度转义**成 `\\n`，`JSON.parse` 后是"反斜杠+n"两个字符，Excalidraw 原样渲染（tldraw 时代 `toRichText` 恰好吃掉了所以没暴露）。修复：`decodeText()` 把字面量 `\n`/`\r\n`/`\t` 还原为真字符，作用于 create_geo/create_text/connect_shapes/update_text 的文本（真换行符不匹配该正则、不受影响）。待下次生成实测确认
   - [x] move_shape 后绑定箭头不跟随 —— `updateScene` 绕过 Excalidraw 的绑定重算管线（与箭头注入同类问题），程序化改坐标不触发 `updateBoundElements`。修复：move_shape 记下被移动的 id，后处理里对"绑定到被移动形状的箭头"用 `reflowArrow` 自算边到边端点重排（与初始创建同一套 `edgePoint` 逻辑，不依赖管线）。代价：手动弯折会被拉直（模型移动场景可接受）。用户手动拖动不受影响（Excalidraw 原生管线照常）
     - [x] 箭头压在外框线上 —— `GAP` 2→8，端点离形状边更明显（创建/移动同源，一处改两处生效）
     - [x] 斜向连菱形/椭圆时箭头离形状较远（动一下才贴回）—— 第一版：`edgePoint` 改按 type 求真实边界交点（好了很多但仍有残留漂移，见下）
     - [x] 残留漂移：动一下端点还会跳一点 —— 把原生端点几何按算法**重写为纯函数** `src/canvas/bindingGeometry.ts`（rect/diamond 轮廓按 gap 外扩后逐边求交、ellipse 半轴+gap 解析解、射线从另一端穿 focus 点取最近交点；两端绑定定点迭代）。算法移植自 Excalidraw（MIT，已注明）。但仍有 ~2px 残留，见下
       - 真根因（探针实测确认）：**Excalidraw 才是 focus/gap 的真相源，端点是从它们派生的**。`bindLinearElement→calculateFocusAndGap` 会按几何**反推并存下 focus（常≠0，朝某个角）、gap**；而我固定 focus=0 算几何、移动时又不同步 binding → 不一致。第一次拖动原生用存的 focus(如0.49) 重算 → 端点从我的中心点跳到偏心点（"动一下后正常"正是此）。手画形状默认是**圆角**（`currentItemRoundness:"round"`），focus≠0 把端点推向圆角处，我的直边近似在角上差几十像素（曾"动得更多"）
       - 最终修复：`reflowArrow` 把两端 binding **重置为 focus=0 / gap=8** 并写中心几何（不再沿用存的偏心 focus）。理由：① 中心瞄准使端点落在**边中段、远离圆角**，直边近似在那里零误差；② focus 在移动/微调时不被原生重算（探针证实其值恒定），故写 focus=0 后原生下次也瞄中心 → 复现我的点。探针实测：移动后再手动碰一下，`deltaStart/deltaEnd = {0,0}`（像素级吻合，零跳动）。代价：模型移动会把手画箭头的偏心贴附重置为中心贴附（与模型自建箭头一致，可接受）
       - 单测 `bindingGeometry.test.ts` 8 例（菱形斜向、椭圆在轮廓上、不动点稳定、旋转、focus≠0）；`solveEndpoint` 已支持 focus≠0（为后续"多箭头按边分配"铺路，当前写入恒用 0）。删除旧 `edgePoint`
     - [ ] （已评估放弃）合成 PointerEvent 模拟拖动 / fork 重编译 Excalidraw：前者无程序化拖动 API、pointer-capture 不稳、难 headless 测；后者 monorepo 构建+维护重、软锁定、仍不可测。vendor 纯函数几何已拿到同等保真且可测，故不走
