import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  buildIndex,
  canBranchFrom,
  descendantIds,
  getNode,
  mergeUserMessage,
  validateMerge,
  type ChatNode,
} from '@llmb/shared';
import { config } from './config';
import * as repo from './db';
import { abortGenerations, runGeneration, type StreamEvent } from './generation';

const app = new Hono();

const DEFAULT_TREE_TITLE = 'New tree';
const titleFrom = (text: string) => {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line || DEFAULT_TREE_TITLE;
};

/** Single place that decides who the user is. Swap for real auth when deployed. */
function getUserId(_c: Context): string {
  return 'local';
}

const bad = (c: Context, message: string, status: 400 | 404 | 409 = 400) =>
  c.json({ error: message }, status);

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Send = (event: string, data: unknown) => void;

/** SSE response whose writes are queued, so they stay ordered and the last one is flushed before close. */
function sse(c: Context, run: (send: Send) => Promise<void>) {
  return streamSSE(c, async (stream) => {
    let queue = Promise.resolve();
    const send: Send = (event, data) => {
      queue = queue.then(async () => {
        if (stream.aborted || stream.closed) return;
        await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      });
    };
    try {
      await run(send);
    } finally {
      await queue;
    }
  });
}

/** StreamEvent → SSE event of the same name. */
function sendEvent(send: Send, e: StreamEvent) {
  if (e.type === 'node') send('node', e.node);
  else if (e.type === 'step') send('step', { nodeId: e.nodeId, ...e.step });
  else {
    const { type, ...data } = e;
    send(type, data);
  }
}

/**
 * Respond with an SSE stream: `node` (the created/reset node), then `token`s,
 * then `done` or `error`. While replying, the assistant may use tools; that adds
 * `step` events and, for other nodes it touches, `node`/`token`/`done` (merges)
 * and `deleted`. The generation continues if the client disconnects.
 */
function streamNode(c: Context, node: ChatNode) {
  return sse(c, async (send) => {
    send('node', node);
    await runGeneration(node, (e) => sendEvent(send, e));
  });
}

app.get('/api/health', (c) =>
  c.json({ ok: true, hasApiKey: Boolean(config.openrouterApiKey), mock: config.mockLlm, chatModel: config.chatModel }),
);

// ---------------------------------------------------------------- trees

app.get('/api/trees', (c) => c.json(repo.listTrees(getUserId(c))));

app.post('/api/trees', async (c) => {
  const b = await body(c);
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : DEFAULT_TREE_TITLE;
  return c.json(repo.createTree(getUserId(c), title), 201);
});

app.get('/api/trees/:id', (c) => {
  const tree = repo.getTree(getUserId(c), c.req.param('id'));
  if (!tree) return bad(c, 'Tree not found', 404);
  return c.json({ tree, nodes: repo.getNodesOfTree(tree.id) });
});

app.patch('/api/trees/:id', async (c) => {
  const b = await body(c);
  if (typeof b.title !== 'string' || !b.title.trim()) return bad(c, 'title is required');
  if (!repo.renameTree(getUserId(c), c.req.param('id'), b.title.trim())) return bad(c, 'Tree not found', 404);
  return c.json(repo.getTree(getUserId(c), c.req.param('id')));
});

app.delete('/api/trees/:id', (c) => {
  const userId = getUserId(c);
  const treeId = c.req.param('id');
  if (!repo.getTree(userId, treeId)) return bad(c, 'Tree not found', 404);
  abortGenerations(repo.getNodesOfTree(treeId).map((n) => n.id));
  repo.deleteTree(userId, treeId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- nodes

app.post('/api/nodes', async (c) => {
  const userId = getUserId(c);
  const b = await body(c);
  if (typeof b.parentId !== 'string') return bad(c, 'parentId is required');
  if (typeof b.userMessage !== 'string' || !b.userMessage.trim()) return bad(c, 'userMessage is required');

  const treeId = repo.getOwnedTreeIdOfNode(userId, b.parentId);
  if (!treeId) return bad(c, 'Parent not found', 404);
  const parent = getNode(buildIndex(repo.getNodesOfTree(treeId)), b.parentId);
  if (!canBranchFrom(parent)) return bad(c, 'Parent has no finished reply yet', 409);

  const node = repo.insertNode({
    treeId, parentIds: [parent.id], kind: 'chat', userMessage: b.userMessage, model: config.chatModel,
  });
  // Name untitled trees after their first message.
  if (repo.getTree(userId, treeId)?.title === DEFAULT_TREE_TITLE) {
    repo.renameTree(userId, treeId, titleFrom(b.userMessage));
  }
  return streamNode(c, node);
});

app.post('/api/merges', async (c) => {
  const userId = getUserId(c);
  const b = await body(c);
  const ids = b.parentIds;
  if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((x) => typeof x === 'string')) {
    return bad(c, 'parentIds must be two node ids');
  }
  const [a, bb] = ids as [string, string];
  const treeId = repo.getOwnedTreeIdOfNode(userId, a);
  if (!treeId || repo.getOwnedTreeIdOfNode(userId, bb) !== treeId) return bad(c, 'Nodes not found', 404);

  const index = buildIndex(repo.getNodesOfTree(treeId));
  const check = validateMerge(index, a, bb);
  if (!check.ok) return bad(c, check.reason, 409);

  const instruction = typeof b.instruction === 'string' && b.instruction.trim() ? b.instruction.trim() : undefined;
  const node = repo.insertNode({
    treeId,
    parentIds: [a, bb],
    kind: 'merge',
    userMessage: mergeUserMessage(getNode(index, a), getNode(index, bb), instruction),
    ...(instruction && { mergeInstruction: instruction }),
    model: config.mergeModel,
  });
  return streamNode(c, node);
});

app.post('/api/nodes/:id/retry', (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const treeId = repo.getOwnedTreeIdOfNode(userId, id);
  if (!treeId) return bad(c, 'Node not found', 404);
  const node = getNode(buildIndex(repo.getNodesOfTree(treeId)), id);
  if (node.status !== 'error') return bad(c, 'Only failed nodes can be retried', 409);

  const model = node.kind === 'merge' ? config.mergeModel : config.chatModel;
  repo.resetForRetry(id, model);
  const { error: _old, actions: _oldActions, ...rest } = node;
  return streamNode(c, { ...rest, assistantMessage: '', status: 'streaming', model });
});

app.delete('/api/nodes/:id', (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const treeId = repo.getOwnedTreeIdOfNode(userId, id);
  if (!treeId) return bad(c, 'Node not found', 404);
  const index = buildIndex(repo.getNodesOfTree(treeId));
  if (getNode(index, id).kind === 'root') return bad(c, 'Cannot delete the root; delete the tree instead', 409);

  const deletedIds = [id, ...descendantIds(index, id)];
  abortGenerations(deletedIds);
  repo.deleteNodes(treeId, deletedIds);
  return c.json({ deletedIds });
});

// ---------------------------------------------------------------- start

const interrupted = repo.markInterrupted();
if (interrupted) console.log(`marked ${interrupted} interrupted generation(s) as failed`);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
