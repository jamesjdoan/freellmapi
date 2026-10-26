import type { ChatCompletionChunk, ChatCompletionResponse, ChatToolCall } from '@freellmapi/shared/types.js';
import { rescueInlineToolCalls } from '../../lib/tool-call-rescue.js';

// Collects one streamed completion into the shape the bench grades.
//
// The bench was written against non-streamed calls, but real agent traffic
// streams, and the two fail differently: nvidia/stepfun-ai/step-5-preview
// answered non-streamed tool calls in 2-16s and returned an empty stream on
// every routed attempt. A probe that does not stream cannot see that, so the
// scheduled probe streams and this turns the stream back into a completion.
//
// It mirrors what the proxy's streamed path does with the same chunks
// (lib/inbound-chat.ts), so a route is judged by what real traffic would get:
//   - an in-band error frame is an error;
//   - tool-call deltas are joined by index;
//   - an inline tool-call dialect in the text is rescued when tools were
//     offered, exactly as the proxy rescues it for a client;
//   - no text and no tool call is an "empty completion" — the same message
//     the fallback loop keys its retry on — including a reasoning-only turn.
// It does NOT repair tool arguments: the bench grades the raw arguments, and
// repairing them would hide the malformed JSON it exists to catch.

export interface CollectedStream {
  response: ChatCompletionResponse;
  /** Milliseconds from `startedAtMs` to the first content, reasoning or tool
   *  delta; null when nothing arrived. */
  ttfbMs: number | null;
}

export async function collectStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  opts: { label: string; toolNames: Set<string>; startedAtMs: number },
): Promise<CollectedStream> {
  let text = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'] | undefined;
  let ttfbMs: number | null = null;
  let id = '';
  let model = '';
  const toolAcc = new Map<number, { id?: string; name: string; args: string }>();

  for await (const chunk of stream) {
    const anyChunk = chunk as ChatCompletionChunk & { error?: { message?: string } };
    if (anyChunk.error && !anyChunk.choices) {
      throw new Error(anyChunk.error.message ?? `in-band provider error from ${opts.label}`);
    }
    if (chunk.usage) usage = chunk.usage;
    id ||= chunk.id ?? '';
    model ||= chunk.model ?? '';
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const deltaText = typeof delta.content === 'string' ? delta.content : '';
    const deltaReasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    if ((deltaText || deltaReasoning || delta.tool_calls?.length) && ttfbMs == null) ttfbMs = Date.now() - opts.startedAtMs;
    text += deltaText;
    reasoning += deltaReasoning;
    // Deltas carry an index the shared type does not declare.
    for (const call of (delta.tool_calls ?? []) as Array<Partial<ChatToolCall> & { index?: number; function?: { name?: string; arguments?: string } }>) {
      const index = call.index ?? 0;
      const acc = toolAcc.get(index) ?? { name: '', args: '' };
      if (call.id && !acc.id) acc.id = call.id;
      if (call.function?.name) acc.name += call.function.name;
      if (call.function?.arguments) acc.args += call.function.arguments;
      toolAcc.set(index, acc);
    }
  }

  let toolCalls: ChatToolCall[] = [...toolAcc.values()]
    .filter(call => call.name)
    .map((call, index) => ({ id: call.id || `call_probe_${index}`, type: 'function' as const, function: { name: call.name, arguments: call.args || '{}' } }));

  if (toolCalls.length === 0 && opts.toolNames.size > 0 && text) {
    const rescue = rescueInlineToolCalls(text, opts.toolNames);
    if (rescue.detected && rescue.calls) {
      toolCalls = rescue.calls.map((call, index) => ({ id: `call_probe_${index}`, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }));
      text = rescue.cleanText;
    }
  }

  if (!text && toolCalls.length === 0) {
    throw new Error(`empty completion from ${opts.label} (stream produced no content and no tool calls)`);
  }

  // A provider that streams no usage frame still spent tokens; the gateway's
  // chars/4 estimate is flagged so nothing reads it as a provider count.
  const estimate = Math.ceil((text.length + reasoning.length + toolCalls.reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0)) / 4);
  return {
    ttfbMs,
    response: {
      id: id || 'probe',
      object: 'chat.completion',
      created: Math.floor(opts.startedAtMs / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
      }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: estimate, total_tokens: estimate, estimated: true },
    },
  };
}
