import type { ChatNode, NodeId, ToolStep, Tree } from '@llmb/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const api = {
  listTrees: () => send('GET', '/api/trees').then((r) => json<Tree[]>(r)),
  createTree: (title?: string) =>
    send('POST', '/api/trees', { title }).then((r) => json<{ tree: Tree; root: ChatNode }>(r)),
  getTree: (id: string) => send('GET', `/api/trees/${id}`).then((r) => json<{ tree: Tree; nodes: ChatNode[] }>(r)),
  renameTree: (id: string, title: string) => send('PATCH', `/api/trees/${id}`, { title }).then((r) => json<Tree>(r)),
  deleteTree: (id: string) => send('DELETE', `/api/trees/${id}`).then((r) => json<{ ok: true }>(r)),
  deleteNode: (id: NodeId) => send('DELETE', `/api/nodes/${id}`).then((r) => json<{ deletedIds: NodeId[] }>(r)),
};

export interface StreamHandlers {
  node: (node: ChatNode) => void;
  token: (nodeId: NodeId, text: string) => void;
  done: (nodeId: NodeId, text: string) => void;
  error: (nodeId: NodeId, message: string) => void;
  /** The assistant used a tool while writing nodeId's reply. */
  step: (nodeId: NodeId, step: ToolStep) => void;
  /** A tool deleted these nodes. */
  deleted: (ids: NodeId[]) => void;
}

/** POST that answers with an SSE stream (node, token*, done|error). Rejects on HTTP errors. */
export async function streamPost(url: string, body: unknown, h: StreamHandlers): Promise<void> {
  const res = await send('POST', url, body);
  if (!res.ok || !res.body) await json(res); // throws with the server's message

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatch(raw, h);
    }
  }
}

function dispatch(raw: string, h: StreamHandlers) {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return;
  const payload = JSON.parse(data.join('\n'));
  if (event === 'node') h.node(payload as ChatNode);
  else if (event === 'token') h.token(payload.nodeId, payload.text);
  else if (event === 'done') h.done(payload.nodeId, payload.text);
  else if (event === 'error') h.error(payload.nodeId, payload.message);
  else if (event === 'step') h.step(payload.nodeId, { text: payload.text, ok: payload.ok });
  else if (event === 'deleted') h.deleted(payload.ids);
}
