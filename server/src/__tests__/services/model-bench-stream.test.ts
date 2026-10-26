import { describe, it, expect } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { collectStream } from '../../services/model-bench/stream.js';

// The probe streams because routed traffic streams, and the two fail
// differently. These pin the cases where a streamed answer is not what a
// non-streamed one would have been.

const chunk = (delta: Record<string, unknown>, extra: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk => ({
  id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm',
  choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason: null }],
  ...extra,
});

async function* from(chunks: unknown[]): AsyncGenerator<ChatCompletionChunk> {
  for (const c of chunks) yield c as ChatCompletionChunk;
}

const opts = (tools: string[] = []) => ({ label: 'test/m', toolNames: new Set(tools), startedAtMs: Date.now() });

describe('collectStream', () => {
  it('joins tool-call deltas by index into whole calls with their raw arguments', async () => {
    const { response } = await collectStream(from([
      chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'convert_', arguments: '{"amount":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'currency', arguments: '250,"from":"EUR"' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ',"to":"USD"}' } }] }),
      { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ]), opts(['convert_currency', 'get_weather']));
    const msg = response.choices[0].message;
    expect(msg.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'convert_currency', arguments: '{"amount":250,"from":"EUR","to":"USD"}' } },
      { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    expect(response.choices[0].finish_reason).toBe('tool_calls');
    // The provider's own count, not an estimate.
    expect(response.usage).toEqual({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  });

  it('keeps malformed arguments malformed so the grader can see them', async () => {
    const { response } = await collectStream(from([
      chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'convert_currency', arguments: '{"amount": 250,' } }] }),
    ]), opts(['convert_currency']));
    expect(response.choices[0].message.tool_calls![0].function.arguments).toBe('{"amount": 250,');
  });

  it('calls a stream with neither text nor tool calls an empty completion, reasoning or not', async () => {
    await expect(collectStream(from([chunk({ role: 'assistant' }), chunk({ content: '' })]), opts()))
      .rejects.toThrow(/empty completion from test\/m/);
    await expect(collectStream(from([chunk({ reasoning_content: 'thinking about it' })]), opts()))
      .rejects.toThrow(/empty completion/);
  });

  it('treats an in-band error frame as an error, not an answer', async () => {
    await expect(collectStream(from([{ error: { message: 'upstream overloaded' } }]), opts()))
      .rejects.toThrow('upstream overloaded');
  });

  it('rescues an inline tool-call dialect when tools were offered, as the proxy does', async () => {
    const { response } = await collectStream(from([
      chunk({ content: '<tool_call>{"name": "convert_currency", "arguments": {"amount": 250}}</tool_call>' }),
    ]), opts(['convert_currency']));
    expect(response.choices[0].message.tool_calls?.[0].function.name).toBe('convert_currency');
    expect(response.choices[0].message.content).toBe('');
  });

  it('flags a usage it had to estimate', async () => {
    const { response, ttfbMs } = await collectStream(from([chunk({ content: 'hello world!' })]), opts());
    expect(response.usage).toMatchObject({ completion_tokens: 3, estimated: true });
    expect(ttfbMs).not.toBeNull();
  });
});
