import type { HarnessSession } from '../harness'
import type { AgentQuestionAnswer } from '../agent'
import { formatCanvas, type CanvasPort } from '../protocol'
import type { ChatCallbacks, ChatEngine } from './chatEngine'

/** The project role uses an independent workspace-write thread from the canvas role. */
export class HarnessProjectEngine implements ChatEngine {
  readonly id = 'project-harness'
  readonly label = 'Project Agent'
  private active: HarnessSession | null = null

  private readonly getSession: () => HarnessSession | null
  private readonly getPort: () => CanvasPort | null
  constructor(getSession: () => HarnessSession | null, getPort: () => CanvasPort | null) {
    this.getSession = getSession
    this.getPort = getPort
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const session = this.getSession()
    if (!session) throw new Error('Open a project and configure a harness provider first')
    this.active = session
    try {
      const port = this.getPort()
      const shapes = port?.snapshot('selection') ?? []
      const image = shapes.length ? await port?.exportImage('selection') : undefined
      const prompt = shapes.length
        ? `${text}\n\nThe current FlowM canvas design is attached. Use it as context for work in this project:\n${formatCanvas(shapes)}`
        : text
      await session.send({ prompt, images: image ? [image] : [] }, cb)
    } finally { this.active = null }
  }
  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.active) throw new Error('This project question is no longer active')
    await this.active.answer(answer)
  }
  async cancel(): Promise<void> { await this.active?.cancel() }
}
