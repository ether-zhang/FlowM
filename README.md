# FlowM

一个用于和大模型双向交互的画布类流程图软件：用户在无限画布上放置/手绘图形并发送给大模型；大模型既能给文字回复，也能**通过工具直接操纵画布**。

## 技术栈

- **前端**：React + TypeScript + Vite
- **画布**：[Excalidraw](https://github.com/excalidraw/excalidraw)（MIT；无限画布 / 形状 / 手绘 / 带绑定的箭头 / 可编程 API）
- **大模型**：[Poe](https://creator.poe.com/docs/external-applications/openai-compatible-api) 的 OpenAI 兼容接口（`openai` SDK，`base_url=https://api.poe.com/v1`，默认模型 `claude-opus-4.8`，function calling）
- **桌面**（计划）：Tauri；**iPad**（计划）：PWA

跨平台：web 为核心运行时，三端共享业务逻辑。

## 模块

```
src/
  protocol/   ★ 画布↔LLM 独立协议：操作原语 schema、序列化、工具定义（与 UI/LLM 解耦）
  canvas/     Excalidraw 封装 + 协议 CanvasPort 的 Excalidraw 实现
  llm/        LlmAdapter 接口（provider 中立）+ Poe(OpenAI 兼容)实现 + tool-use 对话循环
  chat/       右侧对话栏 UI
  persistence/ 工程保存/加载（经 CanvasPort 序列化的画布 + 对话历史）
  app/        两栏布局与装配
```

核心思想：`protocol/` 把"图形化双向交互"定义为独立协议，`llm/` 与 `canvas/` 只依赖窄接口（且
LLM 层用 provider 中立类型），便于将来替换画布、切换大模型 provider，或接已有 agent（claude code / codex）。

## 开发

```bash
npm install
npm run dev      # 启动开发服务器
npm test         # 运行 protocol 单元测试
npm run build    # 生产构建
```

## 桌面版（Tauri）

桌面壳把前端包成 Win/Mac 原生窗口，并**把模型调用移到 Rust 后端**：Poe Key 存在应用数据目录（不进入渲染层/JS），HTTP 请求由 Rust 发起（无浏览器 CORS）。

**前置**：安装 Rust 工具链 —— [rustup](https://rustup.rs)（Windows 另需 “Microsoft C++ Build Tools / MSVC”）。

```bash
npm run tauri dev        # 开发：自动起 Vite + 打开桌面窗口（首次会联网编译 Rust 依赖，较慢）
npx tauri icon icon.png  # 打包前先用一张方形 PNG 生成 src-tauri/icons/*
npm run tauri build      # 产出安装包
```

桌面窗口内点 **Key** 设置的密钥会写入 Rust 后端文件，**不**经 `localStorage`、不出现在前端代码里。运行时自动识别：浏览器走 `localStorage` + Vite 代理，Tauri 走 Rust 后端。

## 使用

1. 打开应用，在画布上用左侧工具栏放置方块 / 手绘 / 文字。
2. 右上角 **Key** 按钮设置 Poe API Key（在 poe.com/api/keys 获取，仅存于浏览器 localStorage）。
3. 选中图形（可选），在右侧对话栏描述需求并发送；模型会以文字回复并直接修改画布。
4. **保存 / 加载** 按钮导出/导入工程文件（画布 + 对话）。

> ⚠️ 安全说明：纯浏览器模式下 API Key 经 `dangerouslyAllowBrowser` 在前端使用，仅适合个人/MVP。
> 后续 Tauri 版本应将调用移到 Rust 后端，Key 不入渲染层（见开发计划）。
>
> 备注：Poe OpenAI 兼容接口不支持自定义参数（如 thinking_budget），且 streaming+tools 有偶发静默中断报告，
> 故 MVP 用非流式 chat/completions；模型名按 Poe bot 命名（若 `claude-opus-4.8` 不可用，试 `Claude-Opus-4.8` 或其他在售 Claude bot）。
