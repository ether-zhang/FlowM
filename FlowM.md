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
1. UI相关
   - [x] ~~右侧对话框增长影响画布移动逻辑~~ —— 已修复：整壳锁定视口，对话框内部独立滚动
   - [x] Tauri 桌面壳（需先装 Rust；并把模型调用移到 Rust 后端，Key 不入渲染层）—— 已就绪：`src-tauri/` + `TauriAdapter`，Key 存后端、HTTP 由 Rust 发起。Excalidraw 迁移后 `tauri dev` 已实测（窗口/生成/绑定均正常）
     - [x] 打包态字体：Excalidraw 画布字体（Excalifont/Xiaolai-CJK 等）运行时按 `EXCALIDRAW_ASSET_PATH` 取，默认走 CDN → 离线打包会丢。已配：`scripts/copy-excalidraw-fonts.mjs` 在 pre(dev|build) 把字体拷进 `public/fonts`（gitignore），`index.html` 设 `EXCALIDRAW_ASSET_PATH="/"`，离线从 `dist/fonts` 加载
     - [x] `npm run tauri build` 通过：产出 msi / nsis 安装包 + 便携 `src-tauri/target/release/flowm.exe`（前端与字体已内嵌，自包含；依赖系统 WebView2）
     - [ ] 断网实测画布字体不再 fallback（Excalifont / 中文 Xiaolai）—— 当前断网不便，**暂缓**，择机验证；验证通过这条桌面壳才算 Excalidraw 下打包完全坐实
     - 约定：**后续开发/分发以便携 exe 为准**——日常跑 `src-tauri/target/release/flowm.exe`；只想出 exe 不出安装包用 `npm run tauri build -- --no-bundle`。msi/nsis 按需再出
   - [x] Debug模式：看到序列化后的prompt —— 聊天栏 Debug 开关，逐轮折叠展示 system + 历史 + 工具
   - [x] 返回结果的markdown格式解析 —— 助手回复经 react-markdown + remark-gfm 渲染（代码块/列表/表格），用户与系统消息仍为纯文本

2. 人机交互相关
    2.1 自由笔触模式的识别
   - [ ] 大模型 → 用户端：识别与执行自由笔触（draw）模式，也能图片与流程图双向并行？
   - [ ] 流程图模式 + 随意画图模式：让大模型更合理地自动识别，**同时传图片与序列化流程图也许是关键**？
    2.2 布局优化
   - [ ] 未绑定箭头的处理，也许与上两条相互兼容
   - [ ] 提高模型操作画布的精准度，脚本修改大模型返回的xywh，**一个自动避障与优化排布的脚本也许才是这个模块的核心**?
   - [ ] 提高画布组件的 UI 拖放精准度，上一条加合理的曲线箭头

3. step模式与项目开发能力
   - [ ] step模式，需要结合项目功能5，是先打通功能，再接agent?
   - [ ] 项目功能 5：项目开发能力（流程图 → 工程开发，接已有 agent），step模式，图片与流程图双向并行？
   - [ ] 工程持久记忆能力？

4. 杂项
   - [ ] 可变的大模型接入口（provider / 模型切换 UI；适配器已就绪）
   - [ ] iPad / PWA 收尾（manifest + service worker）
   - [ ] 上下文优化
   - [x] 画布库 tldraw → Excalidraw（MIT，去商用授权风险）；持久化推到 `CanvasPort.serialize/deserialize` 后面 —— 代码+构建+9 单测通过，**待 `npm run dev` 实测画布/箭头绑定**
     - [x] 箭头不生成 bug：`convertToExcalidrawElements` 默认 `regenerateIds:true` 会丢弃我们设的 id → 返回 id 与实际元素不符 → 后续 connect_shapes 全 unresolved。已改 `regenerateIds:false` 固定 id
     - [x] 箭头弯曲异常 / 全指向右 / undo-redo 后才正常：运行时报 `Linear element is not normalized`。根因链：①Excalidraw 运行时要求 `points[0]===[0,0]`，否则 LinearElementEditor 报错、无法编辑；②converter 的 `start/end` 绑定只产出**占位 points**（默认水平）；③即便我自己传 `points[0]=[0,0]`，converter 对**负向**箭头（朝上/朝左）会重置原点到 bbox 左上，又把 `points[0]` 弄歪（所以只有向上的回边那几条报错）。最终方案：**自己算边到边端点**（bbox 射线交点 + GAP）→ 经 converter 建基础元素 → **再用 `getNormalizedPoints` 逻辑强制 `points[0]=[0,0]`**（`normalizeArrow`，直接保证运行时校验的不变量）→ 手工挂 `startBinding/endBinding`（focus=0 对准中心、gap=2）。`edgePoint`/`normalizeArrow` 是纯逻辑；绑定弯曲行为靠运行时验证
     - [ ] 三角形：Excalidraw 无原生三角形，现暂用 diamond 近似，待用闭合三点 line 多边形实现
     - [ ] `update_text` 给原本无标签的容器新增标签（需新建绑定 text 元素 + boundElements 接线）
     - [ ] bundle 瘦身：Excalidraw 拉入 mermaid/katex/cytoscape（多为按需懒加载），评估关闭 TTD/mermaid 特性
