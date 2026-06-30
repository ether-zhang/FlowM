/**
 * Compose the prompt handed to Claude Code when the canvas holds a design: the user's
 * instruction, plus the FlowM canvas spec (shape list) and a pointer to the rendered
 * design image. Pure — the engine wires in the live canvas; this just shapes the text.
 */
export function buildBuildPrompt(userText: string, spec: string, designPath: string): string {
  return `${userText}

────────
Below is the design the user drew on the FlowM canvas (a flowchart / structure diagram). Use it to develop or modify code in the current project directory:
- Design image (Read it first to understand the overall visual structure and layout): ${designPath}
- Shape list (each shape's coordinates, size, and text; arrows are connections / flow):
${spec}`
}
