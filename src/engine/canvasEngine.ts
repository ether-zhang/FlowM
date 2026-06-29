import type { CanvasPort } from '../protocol'
import type { Conversation } from '../llm'
import type { ChatEngine, ChatCallbacks } from './chatEngine'

/**
 * The existing canvas assistant (Conversation tool-use loop over the CanvasPort), behind
 * the ChatEngine interface. Reads the live conversation/port through getters so it always
 * uses the current ones (they're recreated when the API key changes).
 */
export class CanvasEngine implements ChatEngine {
  readonly id: string
  readonly label: string
  private getConv: () => Conversation | null
  private getPort: () => CanvasPort | null
  /** When true (the Claude-backed engine), the adapter transforms the request, so route debug to
   *  the adapter's REAL send (onDebug) and suppress Conversation's misleading logical onRequest. */
  private debugViaAdapter: boolean

  constructor(
    getConv: () => Conversation | null,
    getPort: () => CanvasPort | null,
    opts: { id?: string; label?: string; debugViaAdapter?: boolean } = {},
  ) {
    this.getConv = getConv
    this.getPort = getPort
    this.id = opts.id ?? 'canvas'
    this.label = opts.label ?? '画布助手'
    this.debugViaAdapter = opts.debugViaAdapter ?? false
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const conv = this.getConv()
    const port = this.getPort()
    if (!conv || !port) throw new Error('画布会话未就绪')
    await conv.send(text, port, {
      onText: cb.onText,
      onToolsApplied: cb.onSystem,
      // Poe's onRequest IS what it sends — show it. Claude's adapter transforms the request, so
      // it reports the real send via onDebug instead; suppress the logical view to avoid confusion.
      onRequest: this.debugViaAdapter ? undefined : cb.onRequest,
      onDebug: this.debugViaAdapter ? cb.onDebug : undefined,
    })
  }
}
