import type { CanvasPort } from '../protocol'
import type { Conversation } from '../llm'
import type { AgentQuestionAnswer } from '../agent'
import type { ChatEngine, ChatCallbacks } from './chatEngine'

/**
 * The existing canvas assistant (Conversation tool-use loop over the CanvasPort), behind
 * the ChatEngine interface. Reads the live conversation/port through getters so it always
 * uses the current workspace conversation and drawing surface.
 */
export class CanvasEngine implements ChatEngine {
  readonly id: string
  readonly label: string
  private getConv: () => Conversation | null
  private getPort: () => CanvasPort | null
  private readonly persistCanvas?: () => Promise<void>
  private readonly recordContext?: (value: unknown) => Promise<void>

  constructor(
    getConv: () => Conversation | null,
    getPort: () => CanvasPort | null,
    persistCanvas?: () => Promise<void>,
    recordContext?: (value: unknown) => Promise<void>,
  ) {
    this.getConv = getConv
    this.getPort = getPort
    this.persistCanvas = persistCanvas
    this.recordContext = recordContext
    this.id = 'canvas-harness'
    this.label = 'Canvas Assistant'
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const conv = this.getConv()
    const port = this.getPort()
    if (!conv || !port) throw new Error('画布会话未就绪')
    // The host commits opaque scene data before reporting an applied batch to the model.
    const apply = async (...args: Parameters<CanvasPort['apply']>) => {
      const result = await port.apply(...args)
      await this.persistCanvas?.()
      await this.recordContext?.(result)
      return result
    }
    const scopedPort = new Proxy(port, { get: (target, key) => {
      if (key === 'apply') return apply
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    let canvasBatch = 0
    cb.onActivity?.({ type: 'status', status: 'working' })
    try {
      await conv.send(text, scopedPort, {
        onText: cb.onText,
        onToolsApplied: (summary) => {
          cb.onActivity?.({
            type: 'tool',
            id: `flowm-canvas-${++canvasBatch}`,
            name: 'Canvas update',
            status: 'completed',
            detail: summary,
          })
        },
        onDebug: cb.onDebug,
        onQuestion: cb.onQuestion,
        onActivity: cb.onActivity,
      })
      cb.onActivity?.({ type: 'status', status: 'completed' })
    } catch (error) {
      cb.onActivity?.({ type: 'status', status: 'failed' })
      throw error
    }
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    const conv = this.getConv()
    if (!conv) throw new Error('Canvas conversation is not ready')
    await conv.answerQuestion(answer)
  }

  async cancel(): Promise<void> {
    await this.getConv()?.cancel()
  }
}
