import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentQuestionItem } from '../agentControl'
import { formatUiText, type UiText } from '../app/uiText'
import type { DisplayQuestion } from './types'

interface QuestionCardProps {
  messageId: string
  context: string
  question: DisplayQuestion
  onAnswer(messageId: string, answers: Record<string, string[]>): void | Promise<void>
  text: UiText
}

function normalizedItems(question: DisplayQuestion): AgentQuestionItem[] {
  if (question.items?.length) return question.items
  if (question.prompt) {
    return [{ id: 'question', prompt: question.prompt, allowOther: true }]
  }
  return []
}

export function QuestionCard({ messageId, context, question, onAnswer, text }: QuestionCardProps) {
  const items = useMemo(() => normalizedItems(question), [question])
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const answered = question.answer
  const needsSubmit = items.length > 1 || items.some((item) => item.multiSelect)
  const complete = items.length > 0 && items.every((item) => (answers[item.id]?.length ?? 0) > 0)

  const submit = async (updated: Record<string, string[]>) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onAnswer(messageId, updated)
    } finally {
      setSubmitting(false)
    }
  }

  const select = (item: AgentQuestionItem, value: string) => {
    const next = item.multiSelect
      ? answers[item.id]?.includes(value)
        ? (answers[item.id] ?? []).filter((answer) => answer !== value)
        : [...(answers[item.id] ?? []), value]
      : [value]
    const updated = { ...answers, [item.id]: next }
    setAnswers(updated)
    if (!needsSubmit && next.length) void submit(updated)
  }

  const submitOther = (item: AgentQuestionItem) => {
    const value = otherText[item.id]?.trim()
    if (!value) return
    const updated = {
      ...answers,
      [item.id]: item.multiSelect ? [...(answers[item.id] ?? []), value] : [value],
    }
    setAnswers(updated)
    if (!needsSubmit) void submit(updated)
  }

  return (
    <div className={`msg msg-question${answered ? ' answered' : ''}`}>
      <div className="question-kicker">{text.chat.questionTitle}</div>
      {context && (
        <div className="question-context">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{context}</ReactMarkdown>
        </div>
      )}
      {items.map((item) => {
        const freeFormOnly = !!question.requestId && !item.options?.length
        const options = item.options?.length
          ? item.options
          : freeFormOnly
            ? []
            : [
              { label: text.chat.questionYes },
              { label: text.chat.questionNo },
            ]
        const selected = answers[item.id] ?? []
        const showOther = !answered && (freeFormOnly || (item.allowOther !== false && otherOpen[item.id]))
        return (
          <section key={item.id} className="question-item">
            {item.header && <div className="question-header">{item.header}</div>}
            <div className="question-prompt">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.prompt}</ReactMarkdown>
            </div>
            {!answered && (
              <>
                <div className="question-actions">
                  {options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      disabled={submitting}
                      className={selected.includes(option.label) ? 'selected' : ''}
                      title={option.description}
                      onClick={() => select(item, option.label)}
                    >
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </button>
                  ))}
                  {!freeFormOnly && item.allowOther !== false && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setOtherOpen((open) => ({ ...open, [item.id]: !open[item.id] }))}
                    >
                      {text.chat.questionOther}
                    </button>
                  )}
                </div>
                {showOther && (
                  <div className="question-other">
                    {item.secret ? (
                      <input
                        type="password"
                        disabled={submitting}
                        value={otherText[item.id] ?? ''}
                        placeholder={text.chat.questionOtherPlaceholder}
                        onChange={(event) => setOtherText((values) => ({ ...values, [item.id]: event.target.value }))}
                      />
                    ) : (
                      <textarea
                        value={otherText[item.id] ?? ''}
                        disabled={submitting}
                        placeholder={text.chat.questionOtherPlaceholder}
                        onChange={(event) => setOtherText((values) => ({ ...values, [item.id]: event.target.value }))}
                      />
                    )}
                    <button
                      type="button"
                      disabled={submitting || !otherText[item.id]?.trim()}
                      onClick={() => submitOther(item)}
                    >
                      {text.chat.questionSendOther}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )
      })}
      {answered ? (
        <div className="question-answer">
          {formatUiText(text.chat.questionAnswered, { answer: answered.text })}
        </div>
      ) : needsSubmit ? (
        <button className="question-submit" type="button" disabled={submitting || !complete} onClick={() => void submit(answers)}>
          {text.chat.questionSendOther}
        </button>
      ) : null}
    </div>
  )
}
