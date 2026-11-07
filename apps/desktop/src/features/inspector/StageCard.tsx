import { Chip, Collapsible } from '@/ui'
import { AlertCircle, CheckCircle, ChevronDown } from 'lucide-react'
import { AgentText } from '../../components/AgentText'
import type { StageDetail } from '../../vanguard-output'
import { buildStageMeta } from './stage-meta'

export function StageCard({ stage }: { stage: StageDetail }) {
  const r = stage.record
  const meta = buildStageMeta(r)

  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex flex-row items-center justify-between gap-2 w-full pb-4">
        <ChevronDown className="size-4 text-muted-foreground shrink-0 transition-transform duration-200 group-data-panel-open:rotate-180" />
        <div className="text-sm font-medium font-mono text-left">{r.stage ?? 'run'}</div>
        {r.verdict && <Chip color={r.verdict === 'pass' ? 'success' : 'warning'} variant="outlined">verdict: {r.verdict}</Chip>}
        <Chip
          className="ml-auto flex items-center gap-1 capitalize font-medium!"
          color={r.completed ? 'success' : 'destructive'}
          variant="outlined">
          {r.completed ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          {r.exitReason}
        </Chip>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="pt-0 border-l border-border pl-4">
          <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {meta.map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </div>
          {!!r.findings?.length && <ul>{r.findings.map((finding, i) => (
            <li key={i} className="mb-2 text-sm">
              <strong>{finding.severity}</strong> ({finding.kind}) — {finding.title}
              <div className="whitespace-pre-wrap text-muted-foreground">{finding.evidence}</div>
            </li>
          ))}</ul>}
          {r.verdict && r.diffOmitted && !r.findings && <div className="text-sm text-muted-foreground">findings withheld: {r.diffOmitted}</div>}
          {r.finalText && <AgentText>{r.finalText}</AgentText>}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
