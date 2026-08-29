import { z } from 'zod'

export const DiagramKind = z.enum(['process', 'structure', 'mixed'])
export type DiagramKind = z.infer<typeof DiagramKind>

export const DiagramRegion = z.object({
  ref: z.string().min(1),
  kind: z.enum(['process', 'structure']),
  purpose: z.string().min(1),
  primaryRefs: z.array(z.string().min(1)).min(1),
  supportingRefs: z.array(z.string().min(1)).default([]),
})
export type DiagramRegion = z.infer<typeof DiagramRegion>

export const DiagramPlan = z.object({
  kind: DiagramKind,
  focus: z.string().min(1),
  regions: z.array(DiagramRegion).min(1),
}).superRefine((plan, ctx) => {
  const regionRefs = new Set<string>()
  const shapeRefs = new Set<string>()

  for (const [index, region] of plan.regions.entries()) {
    if (regionRefs.has(region.ref)) {
      ctx.addIssue({
        code: 'custom',
        path: ['regions', index, 'ref'],
        message: `duplicate region ref ${region.ref}`,
      })
    }
    regionRefs.add(region.ref)

    for (const [field, refs] of [
      ['primaryRefs', region.primaryRefs],
      ['supportingRefs', region.supportingRefs],
    ] as const) {
      for (const [refIndex, ref] of refs.entries()) {
        if (shapeRefs.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['regions', index, field, refIndex],
            message: `shape ref ${ref} is assigned more than once`,
          })
        }
        shapeRefs.add(ref)
      }
    }

  }

  const kinds = new Set(plan.regions.map((region) => region.kind))
  if (plan.kind === 'mixed') {
    if (!kinds.has('process') || !kinds.has('structure')) {
      ctx.addIssue({
        code: 'custom',
        path: ['regions'],
        message: 'mixed diagrams require at least one process region and one structure region',
      })
    }
  } else if ([...kinds].some((kind) => kind !== plan.kind)) {
    ctx.addIssue({
      code: 'custom',
      path: ['regions'],
      message: `${plan.kind} diagrams may only contain ${plan.kind} regions`,
    })
  }

})
export type DiagramPlan = z.infer<typeof DiagramPlan>

export interface ParsedDiagramPlan {
  plan: DiagramPlan | null
  errors: string[]
}

export function parseDiagramPlan(input: unknown): ParsedDiagramPlan {
  const parsed = DiagramPlan.safeParse(input)
  if (parsed.success) return { plan: parsed.data, errors: [] }
  return {
    plan: null,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join('.')}: ` : ''
      return `${path}${issue.message}`
    }),
  }
}

export function diagramPlanRefs(plan: DiagramPlan): Set<string> {
  return new Set(plan.regions.flatMap((region) => [
    ...region.primaryRefs,
    ...region.supportingRefs,
  ]))
}

export function diagramPlanCounts(plan: DiagramPlan): { primary: number; supporting: number } {
  let primary = 0
  let supporting = 0
  for (const region of plan.regions) {
    primary += region.primaryRefs.length
    supporting += region.supportingRefs.length
  }
  return { primary, supporting }
}
