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
