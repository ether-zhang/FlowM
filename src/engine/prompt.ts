/**
 * Compose the prompt handed to Claude Code when the canvas holds a design: the user's
 * instruction, plus the FlowM canvas spec (shape list) and a pointer to the rendered
 * design image. Pure — the engine wires in the live canvas; this just shapes the text.
 */
export function buildBuildPrompt(userText: string, spec: string, designPath: string): string {
  return `${userText}

────────
以下是用户在 FlowM 画布上画的设计（流程图 / 结构图）。请据此在当前工程目录里开发或修改代码：
- 设计图（请先 Read 它，理解整体视觉结构与布局）：${designPath}
- 形状清单（每个形状的坐标、尺寸、文字；箭头表示连接/流向）：
${spec}`
}

/**
 * Compose the prompt for "project → canvas" (draw mode): Claude reads the code the user
 * points at, then returns the structure as the forced StructuredOutput (nodes/edges) — FlowM
 * lays it out and draws it. The schema (DIAGRAM_JSON_SCHEMA) is what actually constrains the
 * shape; this text steers the *content* (main structure only, short labels, real relations).
 */
export function buildDrawPrompt(userText: string): string {
  return `${userText}

────────
请阅读相关代码、理解其结构，然后用结构化输出（StructuredOutput 工具）给出一张「结构图」：
- nodes：关键组件 / 模块 / 步骤，每个一个简短 label（≤6 词）；用 kind 区分类型（process=处理框, decision=判断菱形, terminal=入口/出口椭圆, data=数据/存储）。
- edges：节点之间的调用 / 数据流 / 依赖，from→to 用 node 的 id，可加简短 label。
- 只画主干结构（约 10~20 个节点），不要逐行罗列；让连线表达真实关系。
- 不要修改任何文件；读完直接产出结构（位置由 FlowM 排布，你只给节点与连线）。`
}
