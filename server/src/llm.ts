import type { Message } from '@llmb/shared';
import { config } from './config';

/**
 * Provider adapter (OpenRouter, OpenAI-compatible chat completions API).
 * The rest of the server only knows streamTurn()/streamChat(), so the provider
 * can be swapped by rewriting this file.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model; validated by the caller. */
  arguments: string;
}

export type AgentMessage =
  | Message
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  /** When set, the model may answer with tool calls instead of (or after) text. */
  tools?: ToolSpec[];
  /** 'none' forces a text answer while keeping tool definitions (needed once tool results are in the history). */
  toolChoice?: 'auto' | 'none';
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
}

export class LlmError extends Error {}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string; code?: number | string };
}

/**
 * One streamed model turn. Text goes to onToken as it arrives; tool calls are
 * assembled from their streamed fragments and returned at the end.
 */
export async function streamTurn(req: ChatRequest, onToken: (text: string) => void, signal: AbortSignal): Promise<Turn> {
  if (config.mockLlm) return mockTurn(req, onToken, signal);
  if (!config.openrouterApiKey) throw new LlmError('OPENROUTER_API_KEY is not set in .env.');

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [{ role: 'system', content: req.system }, ...req.messages.map(toWire)],
        ...(req.tools?.length && {
          tools: req.tools.map((t) => ({ type: 'function', function: t })),
          tool_choice: req.toolChoice ?? 'auto',
        }),
      }),
    });
  } catch (err) {
    if (signal.aborted) throw new LlmError('Generation cancelled.');
    throw new LlmError(`Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok || !res.body) throw new LlmError(await httpErrorMessage(res));

  let text = '';
  const calls: { id: string; name: string; arguments: string }[] = [];
  let finish: string | null = null;
  let buffer = '';
  try {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // Blank lines separate events; lines starting with ':' are keep-alive comments.
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = JSON.parse(data) as StreamChunk;
        if (chunk.error) throw new LlmError(`OpenRouter error: ${chunk.error.message ?? 'unknown error'}`);
        const choice = chunk.choices?.[0];
        const piece = choice?.delta?.content;
        if (piece) {
          text += piece;
          onToken(piece);
        }
        for (const d of choice?.delta?.tool_calls ?? []) {
          const c = (calls[d.index] ??= { id: '', name: '', arguments: '' });
          if (d.id) c.id = d.id;
          if (d.function?.name) c.name += d.function.name;
          if (d.function?.arguments) c.arguments += d.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal.aborted) throw new LlmError('Generation cancelled.');
    throw new LlmError(`Stream failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (finish === 'length') throw new LlmError('Reply was cut off (max tokens reached).');
  if (finish === 'content_filter') throw new LlmError('The model declined to answer.');
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}`, arguments: c.arguments || '{}' }));
  if (!text && !toolCalls.length) throw new LlmError('The model returned an empty reply.');
  return { text, toolCalls };
}

/** Plain streamed reply with no tools. Resolves with the full text. */
export async function streamChat(req: Omit<ChatRequest, 'tools'>, onToken: (t: string) => void, signal: AbortSignal) {
  return (await streamTurn(req, onToken, signal)).text;
}

function toWire(m: AgentMessage) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && 'toolCalls' in m) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return m;
}

async function httpErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const detail = body?.error?.message ?? res.statusText;
  switch (res.status) {
    case 401:
      return 'Invalid OpenRouter API key.';
    case 402:
      return 'OpenRouter account is out of credits.';
    case 404:
      return `Model not found on OpenRouter: ${detail}`;
    case 429:
      return 'Rate limited by OpenRouter. Try again shortly.';
    default:
      return `OpenRouter error ${res.status}: ${detail}`;
  }
}

// ---------------------------------------------------------------- mock (MOCK_LLM=1)

/**
 * Fake model. With tools, it understands "merge n2 and n4" / "delete n3" in the
 * last user message and reports the tool results afterwards. Otherwise it echoes
 * what it would have seen.
 */
async function mockTurn(req: ChatRequest, onToken: (t: string) => void, signal: AbortSignal): Promise<Turn> {
  const last = req.messages.at(-1);
  if (req.tools && req.toolChoice !== 'none' && last?.role === 'user') {
    const calls: ToolCall[] = [];
    for (const m of last.content.matchAll(/merge\s+(n\d+)\s+(?:and\s+|with\s+|\+\s*)?(n\d+)/gi)) {
      calls.push({ id: `mock${calls.length}`, name: 'merge_nodes', arguments: JSON.stringify({ a: m[1], b: m[2] }) });
    }
    for (const m of last.content.matchAll(/delete\s+(n\d+)/gi)) {
      calls.push({ id: `mock${calls.length}`, name: 'delete_node', arguments: JSON.stringify({ node: m[1] }) });
    }
    if (calls.length) return { text: await mockStream('On it.', onToken, signal), toolCalls: calls };
  }
  const reply =
    last?.role === 'tool'
      ? `[mock] ${req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' / ')}`
      : `[mock ${req.messages.length} msgs] ${req.messages.map((m) => `${m.role}: ${m.content}`).join(' | ')}`;
  return { text: await mockStream(reply, onToken, signal), toolCalls: [] };
}

async function mockStream(reply: string, onToken: (t: string) => void, signal: AbortSignal) {
  let text = '';
  for (const word of reply.split(/(?<= )/)) {
    if (signal.aborted) throw new LlmError('Generation cancelled.');
    await new Promise((r) => setTimeout(r, 5));
    text += word;
    onToken(word);
  }
  return text;
}
