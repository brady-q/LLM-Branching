import {
  buildContext,
  buildIndex,
  contextChain,
  getNode,
  mergeUserMessage,
  type ChatNode,
  type ToolStep,
} from '@llmb/shared';
import { AGENT_TOOLS, executeTool, Handles, treeOutline, type TreeOps } from './agentTools';
import { config } from './config';
import * as repo from './db';
import { abortGenerations, runGeneration, type StreamEvent } from './generation';
import { streamTurn, type AgentMessage } from './llm';

/** Upper bound on tool round-trips per reply, so a confused model can't loop forever. */
export const MAX_STEPS = 8;

const SYSTEM_PROMPT = `You are a helpful assistant in a branching chat app. The conversation you see is one path through a tree of conversations; earlier turns may include summaries of merged branches.

You can also edit the tree with tools, and you act on your own judgment without asking for confirmation. Use the tools only when the user asks you to change the tree (merge/combine branches, delete branches) or asks about other branches; otherwise just answer normally.

Tree rules:
- The tree is a DAG: merge nodes have two parents. Refer to nodes only by handle (n1, n2, …) from the outline. Never invent handles.
- "Combine" or "merge" branches means merge_nodes on the branch tips (usually leaves). For 3+ branches, merge pairwise, then merge the result.
- delete_node removes the node and everything below it. Only delete what the user asked for. To remove a branch, delete the first node of that branch (the child of the split point), not the split point.
- You cannot delete the conversation you are in (your reply and its ancestors).
- If the request is ambiguous or nothing matches, change nothing and say what you found.
- The user cannot see handles. In your reply, describe nodes by their content (e.g. "the pasta branch"), never as n3.`;

export interface ChatTurn {
  node: ChatNode;
  model: string;
  signal: AbortSignal;
  onToken: (text: string) => void;
  onStep: (step: ToolStep) => void;
  emit: (e: StreamEvent) => void;
  /** Override for tests. */
  ops?: TreeOps;
}

/** Real tree operations, backed by the DB and the normal merge generation. */
function dbOps(treeId: string, emit: (e: StreamEvent) => void): TreeOps {
  return {
    nodes: () => repo.getNodesOfTree(treeId),
    merge: async (a, b, instruction) => {
      const index = buildIndex(repo.getNodesOfTree(treeId));
      const node = repo.insertNode({
        treeId,
        parentIds: [a, b],
        kind: 'merge',
        userMessage: mergeUserMessage(getNode(index, a), getNode(index, b), instruction),
        ...(instruction && { mergeInstruction: instruction }),
        model: config.mergeModel,
      });
      emit({ type: 'node', node });
      // Wait for the summary: a later step may merge this node again, which needs a finished reply.
      await runGeneration(node, emit);
      return getNode(buildIndex(repo.getNodesOfTree(treeId)), node.id);
    },
    remove: (ids) => {
      abortGenerations(ids);
      repo.deleteNodes(treeId, ids);
      emit({ type: 'deleted', ids });
    },
  };
}

/**
 * Write the reply for a chat node. The model may call tools between pieces of
 * text; all text (from every round) streams into the same node.
 */
export async function runChatTurn(t: ChatTurn): Promise<string> {
  const ops = t.ops ?? dbOps(t.node.treeId, t.emit);
  const nodes = ops.nodes();
  const index = buildIndex(nodes);
  const handles = new Handles(nodes);
  const chain = contextChain(index, t.node.id);
  const protectedIds = new Set(chain.map((n) => n.id));

  const system =
    `${SYSTEM_PROMPT}\n\nCurrent tree:\n${treeOutline(index, handles)}\n\n` +
    `You are writing the reply for ${handles.of(t.node.id)}. ` +
    `This conversation's path: ${chain.map((n) => handles.of(n.id)).join(' → ')}.`;
  const messages: AgentMessage[] = buildContext(chain);

  let text = '';
  let needBreak = false; // separate text written before and after tool calls
  const onToken = (piece: string) => {
    if (needBreak) {
      needBreak = false;
      text += '\n\n';
      t.onToken('\n\n');
    }
    text += piece;
    t.onToken(piece);
  };
  const steps: ToolStep[] = [];

  for (let round = 0; ; round++) {
    const turn = await streamTurn(
      { model: t.model, system, messages, tools: AGENT_TOOLS, toolChoice: round < MAX_STEPS ? 'auto' : 'none' },
      onToken,
      t.signal,
    );
    if (!turn.toolCalls.length || round >= MAX_STEPS) break;
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
    // In order: a later call may depend on an earlier one (merge, then merge the result).
    for (const call of turn.toolCalls) {
      const r = await executeTool(call.name, call.arguments, ops, handles, protectedIds);
      // Record changes and failures; plain reads would only clutter the reply.
      if (r.action || !r.ok) {
        const step = { text: r.summary, ok: r.ok };
        steps.push(step);
        t.onStep(step);
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: r.result });
    }
    needBreak = text.length > 0;
  }

  // A reply must have text (it becomes context for later turns).
  if (!text.trim()) text = steps.map((s) => s.text).join('. ') || 'Done.';
  return text;
}
