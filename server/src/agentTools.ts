import {
  buildIndex,
  descendantIds,
  getChildren,
  validateMerge,
  type ChatNode,
  type GraphIndex,
  type NodeId,
} from '@llmb/shared';
import type { ToolSpec } from './llm';

/**
 * The agent's tools. Every call is validated here against the current tree
 * before anything changes; the model's arguments are never trusted. Invalid
 * calls come back to the model as an error result so it can correct itself.
 */

/** Tree mutations the tools can perform. Implemented by the server (agent.ts), faked in tests. */
export interface TreeOps {
  /** Current nodes of the tree (re-read after every change). */
  nodes(): ChatNode[];
  /** Create a merge node and wait for its summary to finish. Returns the final node. */
  merge(a: NodeId, b: NodeId, instruction: string | undefined): Promise<ChatNode>;
  /** Delete these nodes (already expanded to include descendants). */
  remove(ids: NodeId[]): void;
}

/** What a tool changed, so the caller can tell the client. */
export type AgentAction =
  | { type: 'merge'; nodeId: NodeId; parentIds: [NodeId, NodeId] }
  | { type: 'delete'; deletedIds: NodeId[] };

export interface ToolResult {
  /** Text returned to the model. */
  result: string;
  /** One-line summary for the UI. Uses node previews, not handles (the user never sees handles). */
  summary: string;
  ok: boolean;
  action?: AgentAction;
}

export const MAX_INSTRUCTION = 1000;

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'get_tree_outline',
    description:
      'List every node in the conversation tree: handle, kind, status, parents, and a short preview. ' +
      'Call again after changes to see fresh handles.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_node',
    description: 'Read the full user message and assistant reply of one node.',
    parameters: {
      type: 'object',
      properties: { node: { type: 'string', description: 'Node handle, e.g. "n4"' } },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_nodes',
    description:
      'Merge two branches into a new node whose parents are both nodes. The AI summarizes what each branch ' +
      'added since they split. Both nodes must have finished replies and neither may be an ancestor of the other. ' +
      'To combine more than two branches, merge two, then merge the result with the next.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'Handle of the first node (usually a branch leaf)' },
        b: { type: 'string', description: 'Handle of the second node' },
        instruction: { type: 'string', description: 'Optional focus for the summary, e.g. "keep the code"' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_node',
    description:
      'Delete a node AND everything below it (all descendants, including merges that use it). ' +
      'Cannot delete the root. This is permanent.',
    parameters: {
      type: 'object',
      properties: { node: { type: 'string', description: 'Node handle, e.g. "n4"' } },
      required: ['node'],
      additionalProperties: false,
    },
  },
];

/**
 * Short, stable names ("n1", "n2", …) for node ids. Models copy these far more
 * reliably than UUIDs. Handles stay fixed for the whole agent run; new nodes get
 * the next number.
 */
export class Handles {
  private toId = new Map<string, NodeId>();
  private toHandle = new Map<NodeId, string>();
  private next = 1;

  constructor(nodes: ChatNode[]) {
    for (const n of [...nodes].sort((a, b) => a.createdAt - b.createdAt)) this.of(n.id);
  }

  of(id: NodeId): string {
    let h = this.toHandle.get(id);
    if (!h) {
      h = `n${this.next++}`;
      this.toHandle.set(id, h);
      this.toId.set(h, id);
    }
    return h;
  }

  /** Accepts "n4", "N4", "4". */
  resolve(raw: unknown): NodeId | undefined {
    if (typeof raw !== 'string') return undefined;
    const m = /^\s*n?(\d+)\s*$/i.exec(raw);
    return m ? this.toId.get(`n${m[1]}`) : undefined;
  }
}

const preview = (s: string, max = 70) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** How the UI refers to a node. */
export function nodeTitle(n: ChatNode): string {
  if (n.kind === 'root') return 'Start';
  if (n.kind === 'merge') return 'a merged node';
  return `"${preview(n.userMessage, 40)}"`;
}

/** Compact text listing of the tree for the model. */
export function treeOutline(index: GraphIndex, handles: Handles): string {
  const nodes = [...index.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  return nodes
    .map((n) => {
      const h = handles.of(n.id);
      const parents = n.parentIds.map((p) => handles.of(p)).join('+') || '-';
      const kids = getChildren(index, n.id).length;
      const head = `${h} ${n.kind} ${n.status} parents=${parents} children=${kids}`;
      if (n.kind === 'root') return `${head} | (start of conversation)`;
      const user = n.kind === 'merge' ? '(merge)' : `user: "${preview(n.userMessage)}"`;
      const reply = n.status === 'error' ? `error: ${preview(n.error ?? '')}` : `reply: "${preview(n.assistantMessage)}"`;
      return `${head} | ${user} | ${reply}`;
    })
    .join('\n');
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const fail = (summary: string, result = `Error: ${summary}`): ToolResult => ({ ok: false, summary, result });

/**
 * @param protectedIds nodes that must survive: the reply being written and its
 *   ancestors (deleting them would delete the conversation the tool runs in).
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ops: TreeOps,
  handles: Handles,
  protectedIds: ReadonlySet<NodeId> = new Set(),
): Promise<ToolResult> {
  const args = parseArgs(rawArgs);
  if (!args) return fail(`${name}: arguments were not a JSON object`);
  const index = buildIndex(ops.nodes());
  const node = (key: string) => {
    const id = handles.resolve(args[key]);
    return id ? index.byId.get(id) : undefined;
  };

  switch (name) {
    case 'get_tree_outline':
      return { ok: true, summary: 'Read the tree', result: treeOutline(index, handles) };

    case 'get_node': {
      const n = node('node');
      if (!n) return fail(`get_node: unknown node ${JSON.stringify(args.node)}`);
      const h = handles.of(n.id);
      return {
        ok: true,
        summary: `Read ${nodeTitle(n)}`,
        result: `${h} (${n.kind}, ${n.status})\nUSER:\n${n.userMessage}\n\nASSISTANT:\n${n.assistantMessage}`,
      };
    }

    case 'merge_nodes': {
      const a = node('a');
      const b = node('b');
      if (!a || !b) return fail(`merge_nodes: unknown node ${JSON.stringify(a ? args.b : args.a)}`);
      const check = validateMerge(index, a.id, b.id);
      const label = `${nodeTitle(a)} + ${nodeTitle(b)}`;
      if (!check.ok) {
        return fail(`Can't merge ${label}: ${check.reason}`, `Error: can't merge ${handles.of(a.id)} + ${handles.of(b.id)}: ${check.reason}`);
      }
      if (args.instruction !== undefined && typeof args.instruction !== 'string') {
        return fail('merge_nodes: instruction must be a string');
      }
      const instruction = (args.instruction as string | undefined)?.trim().slice(0, MAX_INSTRUCTION) || undefined;

      const merged = await ops.merge(a.id, b.id, instruction);
      const h = handles.of(merged.id);
      const action: AgentAction = { type: 'merge', nodeId: merged.id, parentIds: [a.id, b.id] };
      if (merged.status !== 'done') {
        return {
          ok: false,
          action,
          summary: `Merged ${label}, but the summary failed`,
          result: `Created ${h} but its summary failed: ${merged.error ?? 'unknown error'}`,
        };
      }
      return {
        ok: true,
        action,
        summary: `Merged ${label}`,
        result: `Created merge node ${h}. Summary preview: "${preview(merged.assistantMessage, 200)}"`,
      };
    }

    case 'delete_node': {
      const n = node('node');
      if (!n) return fail(`delete_node: unknown node ${JSON.stringify(args.node)}`);
      const h = handles.of(n.id);
      if (n.kind === 'root') return fail("Can't delete the start of the tree", `Error: ${h} is the root and cannot be deleted`);
      const deletedIds = [n.id, ...descendantIds(index, n.id)];
      if (deletedIds.some((id) => protectedIds.has(id))) {
        return fail(
          `Can't delete ${nodeTitle(n)}: this conversation is part of that branch`,
          `Error: ${h} contains the current conversation, so it can't be deleted from here. ` +
            'Tell the user to open a different branch (e.g. go back above the split) and ask again there.',
        );
      }
      ops.remove(deletedIds);
      const extra = deletedIds.length - 1;
      const gone = deletedIds.map((id) => handles.of(id)).join(', ');
      return {
        ok: true,
        action: { type: 'delete', deletedIds },
        summary: `Deleted ${nodeTitle(n)}${extra ? ` and ${extra} node${extra === 1 ? '' : 's'} below it` : ''}`,
        result: `Deleted ${gone}. These handles no longer exist.`,
      };
    }

    default:
      return fail(`Unknown tool "${name}"`);
  }
}
