import { buildIndex, buildMergeRequest, mergeInputs, type ChatNode, type NodeId, type ToolStep } from '@llmb/shared';
import { runChatTurn } from './agent';
import { config } from './config';
import * as repo from './db';
import { streamChat } from './llm';

/** Running generations, so deletes can abort them. */
const active = new Map<NodeId, AbortController>();

export function abortGenerations(ids: Iterable<NodeId>) {
  for (const id of ids) active.get(id)?.abort();
}

/**
 * Everything a generation reports. One reply can touch other nodes too (the
 * assistant's tools create merge nodes and delete nodes), so events carry ids.
 */
export type StreamEvent =
  | { type: 'node'; node: ChatNode }
  | { type: 'token'; nodeId: NodeId; text: string }
  | { type: 'step'; nodeId: NodeId; step: ToolStep }
  | { type: 'done'; nodeId: NodeId; text: string }
  | { type: 'error'; nodeId: NodeId; message: string }
  | { type: 'deleted'; ids: NodeId[] };

const FLUSH_MS = 500;

/** Merge summary: built from the DB state, never from client-supplied history. */
function mergeReply(node: ChatNode, model: string, onToken: (t: string) => void, signal: AbortSignal) {
  const index = buildIndex(repo.getNodesOfTree(node.treeId));
  const [a, b] = node.parentIds;
  if (!a || !b) throw new Error('Merge node without two parents');
  return streamChat({ model, ...buildMergeRequest(mergeInputs(index, a, b), node.mergeInstruction) }, onToken, signal);
}

/**
 * Stream a reply into an existing 'streaming' node. Keeps running even if the
 * listener (the HTTP client) goes away; progress is flushed to the DB.
 */
export async function runGeneration(node: ChatNode, emit: (e: StreamEvent) => void): Promise<void> {
  const model = node.model ?? (node.kind === 'merge' ? config.mergeModel : config.chatModel);
  const controller = new AbortController();
  active.set(node.id, controller);
  let text = '';
  let dirty = false;
  const steps: ToolStep[] = [];
  const timer = setInterval(() => {
    if (dirty) {
      repo.setAssistantText(node.id, text);
      dirty = false;
    }
  }, FLUSH_MS);
  const onToken = (t: string) => {
    text += t;
    dirty = true;
    emit({ type: 'token', nodeId: node.id, text: t });
  };

  try {
    text =
      node.kind === 'merge'
        ? await mergeReply(node, model, onToken, controller.signal)
        : await runChatTurn({
            node,
            model,
            signal: controller.signal,
            onToken,
            onStep: (step) => {
              steps.push(step);
              repo.setActions(node.id, steps);
              emit({ type: 'step', nodeId: node.id, step });
            },
            emit,
          });
    repo.finishNode(node.id, text);
    emit({ type: 'done', nodeId: node.id, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    repo.failNode(node.id, text, message); // no-op if the node was deleted
    emit({ type: 'error', nodeId: node.id, message });
  } finally {
    clearInterval(timer);
    active.delete(node.id);
  }
}
