import { useCallback } from 'react'

/**
 * A thin draggable divider that resizes an adjacent fixed-width pane. `sign` is +1 when dragging
 * right should GROW the pane (a left pane's right edge) and -1 when it should SHRINK it (a right
 * pane's left edge). Width is clamped to [min, max]. Pointer capture keeps the drag smooth even
 * when the cursor outruns the 5px handle.
 */
export function Resizer({
  width,
  setWidth,
  sign,
  min = 180,
  max = 640,
}: {
  width: number
  setWidth: (w: number) => void
  sign: 1 | -1
  min?: number
  max?: number
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const el = e.currentTarget
      const startX = e.clientX
      const startW = width
      el.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const next = Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX)))
        setWidth(next)
      }
      const up = () => {
        el.releasePointerCapture(e.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    },
    [width, setWidth, sign, min, max],
  )
  return <div className="resizer" onPointerDown={onPointerDown} />
}
