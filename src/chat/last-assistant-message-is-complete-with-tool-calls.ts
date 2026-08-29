import { getToolName, isToolUIPart, type UIMessage } from '../types/message'

/**
 * 判断最后一条消息是否为「工具调用已完成」的 assistant 消息。
 * 语义对齐 AI SDK：只看最后一个 step（step-start 之后）的工具部件，
 * 至少一个工具调用，且全部处于 output-available / output-error。
 * sendAutomaticallyWhen 常用它决定是否自动续跑。
 */
export function lastAssistantMessageIsCompleteWithToolCalls({
  messages,
}: {
  messages: UIMessage[]
}): boolean {
  const message = messages[messages.length - 1]

  if (!message) return false
  if (message.role !== 'assistant') return false

  const lastStepStartIndex = message.parts.reduce((lastIndex, part, index) => {
    return part.type === 'step-start' ? index : lastIndex
  }, -1)

  const lastStepToolInvocations = message.parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolUIPart)
    .filter((part) => !part.providerExecuted)

  return (
    lastStepToolInvocations.length > 0 &&
    lastStepToolInvocations.every(
      (part) => part.state === 'output-available' || part.state === 'output-error',
    )
  )
}

export { getToolName, isToolUIPart }
