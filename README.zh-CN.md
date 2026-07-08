# FlowM

中文 | [English](README.md)

FlowM 是一个面向 AI 协作的画布工具，用来理解代码、绘制技术图、把自由草图继续推进成工程任务。它把类似 Excalidraw 的无限画布和具备项目感知能力的助手结合起来：你可以让模型阅读代码仓库，解释工作原理，直接在画布上绘制或修正图形，并基于已有画布继续开发。FlowM 可以接入 Claude Code 和 Codex agent，用于具备项目感知能力的本地工作流。

## 演示

### 1. 理解代码后画流程图

FlowM 可以读取项目代码，并基于真实实现绘制流程图。

![理解代码后画流程图](docs/media/Flow-1.gif)

### 2. 基于流程图继续画子流程

在已有流程图基础上，助手可以继续细化选中区域，或展开更具体的子流程。

![基于流程图继续画子流程](docs/media/Flow-2.gif)

### 3. 更复杂的结构图生成

FlowM 不只适合线性流程，也可以生成包含多个关联区域的架构图和结构图。

![更复杂的结构图生成](docs/media/Struct-1.gif)

### 4. 自由绘画

你可以先在画布上自由绘制，再让助手理解、整理或继续补全。

![自由绘画](docs/media/Draw-2.gif)

### 5. 基于画布推进工程开发

FlowM 可以把画布内容作为上下文，继续推进工程开发，把图形设计和代码修改连接起来。

![基于画布推进工程开发](docs/media/Draw-3.gif)

## 下载

请到 GitHub Releases 页面下载最新桌面版本：

<https://github.com/ether-zhang/FlowM/releases>

## 开发

前置要求：

- Node.js 和 npm
- Rust 工具链，用于 Tauri 桌面应用
- 可选：Claude Code、Codex CLI 等本地 Agent，用于项目感知的本地助手模式

安装依赖：

```bash
npm install
```

启动 Web 开发服务：

```bash
npm run dev
```

运行测试与构建：

```bash
npm test
npm run build
```

启动桌面端开发模式：

```bash
npm run tauri -- dev
```

构建桌面应用：

```bash
npm run tauri -- build
```

## 主要开源项目

FlowM 基于多个重要开源项目构建：

- [Excalidraw](https://github.com/excalidraw/excalidraw)：画布、绘图基础能力和导出流程
- [React](https://react.dev/) 和 [TypeScript](https://www.typescriptlang.org/)：应用界面和类型化前端代码
- [Tauri](https://tauri.app/)：桌面外壳和原生系统集成
- [Vite](https://vite.dev/)：前端开发和构建工具
- [OpenAI JavaScript SDK](https://github.com/openai/openai-node)：OpenAI 兼容 API 接入
- [Zod](https://zod.dev/)：画布操作和协议数据的运行时校验
- [React Markdown](https://github.com/remarkjs/react-markdown) 和 [remark-gfm](https://github.com/remarkjs/remark-gfm)：助手面板中的 Markdown 渲染
- [Vitest](https://vitest.dev/)：单元测试

## 许可证

FlowM 使用 [MIT License](LICENSE) 开源。

## 项目状态

FlowM 仍在持续开发中。稳定版本发布前，API、界面行为、Agent 集成方式和文件格式都可能继续调整。

注：项目级开发工作流需要结合具体项目目录使用，目前要求本机已安装 Claude Code 或 Codex；如果只有 API Key，也可以使用画布助手 API 模式进行画布绘制和编辑。
