import { ancestorIds, buildIndex, descendantIds, mergeUserMessage, type ChatNode, type NodeId, type ToolStep } from '@llmb/shared';
import type { TreeOps } from '../src/agentTools';

/**
 * Eval harness for the tree-editing assistant (server/src/agent.ts).
 *
 * A case is a small conversation tree written with readable ids, a new user
 * message placed somewhere in it, and expectations about what the assistant
 * should do. The real model runs against an in-memory tree (no DB); merges get
 * a canned summary instead of a second model call. Graders then compare the
 * final tree and the reply text with the expectations.
 *
 * This file has no imports from agent.ts/db.ts, so it can be unit-tested
 * without a database or an API key; the runner injects the real chat turn.
 */

export interface NodeSpec {
  /** Readable id, used in expectations. Must be unique. 'root' is created automatically. */
  id: string;
  /** Parent id. Two ids make a merge node. */
  parent: string | [string, string];
  user?: string;
  reply: string;
}

export interface Expect {
  /** Nodes that must be gone at the end (each listed node, not its descendants: those are implied). */
  deleted?: string[];
  /**
   * Each group must end up merged: some new merge node descends from every
   * listed node. E.g. [['pasta2', 'pizza2']]. Order inside a group doesn't matter.
   */
  merged?: string[][];
  /** Exact number of merge nodes the assistant should create. Defaults to the number of groups in `merged`, plus 1 per extra member (pairwise merges). */
  mergeCount?: number;
  /** Merge instruction passed to merge_nodes must match (any of the merges). */
  instruction?: RegExp;
  /** Reply must match every pattern. */
  replyMatches?: RegExp[];
  /** Reply must match none of these. */
  replyNot?: RegExp[];
  /** Plain-language rubric for the LLM judge (skipped with --no-judge). */
  rubric?: string;
}

export interface EvalCase {
  name: string;
  /** What the case checks, for the report. */
  tags: string[];
  tree: NodeSpec[];
  /** Where the new message goes, and what the user says. */
  ask: { parent: string; user: string };
  expect: Expect;
}

/** What happened in one run. */
export interface Outcome {
  reply: string;
  steps: ToolStep[];
  merges: { id: NodeId; parents: [NodeId, NodeId]; instruction?: string }[];
  deletedIds: NodeId[];
  /** Final tree. */
  nodes: ChatNode[];
  error?: string;
  ms: number;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export const ASK_ID = 'ask';

export function buildTree(c: EvalCase): ChatNode[] {
  let clock = 1;
  const nodes: ChatNode[] = [
    { id: 'root', treeId: 'eval', parentIds: [], kind: 'root', status: 'root', userMessage: '', assistantMessage: '', createdAt: 0 },
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const s of c.tree) {
    if (byId.has(s.id) || s.id === ASK_ID) throw new Error(`${c.name}: duplicate node id ${s.id}`);
    const parentIds = typeof s.parent === 'string' ? [s.parent] : [...s.parent];
    for (const p of parentIds) if (!byId.has(p)) throw new Error(`${c.name}: ${s.id} has unknown parent ${p}`);
    const kind = parentIds.length === 2 ? 'merge' : 'chat';
    const userMessage =
      s.user ?? (kind === 'merge' ? mergeUserMessage(byId.get(parentIds[0]!)!, byId.get(parentIds[1]!)!) : '');
    const node: ChatNode = {
      id: s.id, treeId: 'eval', parentIds, kind, status: 'done', userMessage, assistantMessage: s.reply, createdAt: clock++,
    };
    nodes.push(node);
    byId.set(s.id, node);
  }
  if (!byId.has(c.ask.parent)) throw new Error(`${c.name}: ask has unknown parent ${c.ask.parent}`);
  nodes.push({
    id: ASK_ID, treeId: 'eval', parentIds: [c.ask.parent], kind: 'chat', status: 'streaming',
    userMessage: c.ask.user, assistantMessage: '', createdAt: clock++,
  });
  return nodes;
}

/** In-memory TreeOps that records what the assistant did. */
export function fakeOps(initial: ChatNode[]) {
  let nodes = [...initial];
  let clock = Math.max(...nodes.map((n) => n.createdAt)) + 1;
  const merges: Outcome['merges'] = [];
  const deletedIds: NodeId[] = [];
  const ops: TreeOps = {
    nodes: () => nodes,
    merge: async (a, b, instruction) => {
      const pa = nodes.find((n) => n.id === a)!;
      const pb = nodes.find((n) => n.id === b)!;
      const id = `merge${merges.length + 1}`;
      merges.push({ id, parents: [a, b], ...(instruction && { instruction }) });
      const node: ChatNode = {
        id, treeId: 'eval', parentIds: [a, b], kind: 'merge', status: 'done',
        userMessage: mergeUserMessage(pa, pb, instruction),
        // Canned, but shaped like a real summary: a sloppy one makes the model redo the merge.
        assistantMessage:
          `Here is what the two branches decided${instruction ? `, focused on: ${instruction}` : ''}.\n\n` +
          `First branch: ${pa.assistantMessage}\n\nSecond branch: ${pb.assistantMessage}`,
        createdAt: clock++,
        ...(instruction && { mergeInstruction: instruction }),
      };
      nodes = [...nodes, node];
      return node;
    },
    remove: (ids) => {
      deletedIds.push(...ids);
      nodes = nodes.filter((n) => !ids.includes(n.id));
    },
  };
  return { ops, merges, deletedIds, current: () => nodes };
}

/** Runs one chat turn. The runner passes the real runChatTurn; tests pass a script. */
export type ChatTurnFn = (args: {
  node: ChatNode;
  ops: TreeOps;
  onToken: (t: string) => void;
  onStep: (s: ToolStep) => void;
}) => Promise<string>;

export async function runCase(c: EvalCase, chatTurn: ChatTurnFn): Promise<Outcome> {
  const initial = buildTree(c);
  const tree = fakeOps(initial);
  const steps: ToolStep[] = [];
  const start = Date.now();
  let reply = '';
  let error: string | undefined;
  try {
    reply = await chatTurn({ node: initial.at(-1)!, ops: tree.ops, onToken: () => {}, onStep: (s) => steps.push(s) });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    reply, steps, merges: tree.merges, deletedIds: tree.deletedIds, nodes: tree.current(),
    ms: Date.now() - start, ...(error && { error }),
  };
}

/** Deterministic checks. Every case also gets the always-on checks (no handles in reply, no failed tool calls). */
export function grade(c: EvalCase, o: Outcome): Check[] {
  const e = c.expect;
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail && !pass && { detail }) });

  if (o.error) {
    add('no error', false, o.error);
    return checks;
  }

  // Deletions: exactly the listed nodes plus their descendants.
  const initial = buildIndex(buildTree(c));
  const want = new Set<NodeId>();
  for (const id of e.deleted ?? []) {
    want.add(id);
    for (const d of descendantIds(initial, id)) want.add(d);
  }
  const deletedOriginal = new Set(o.deletedIds.filter((id) => initial.byId.has(id)));
  const missing = [...want].filter((id) => !deletedOriginal.has(id));
  const extra = [...deletedOriginal].filter((id) => !want.has(id));
  add(
    want.size ? 'deleted the right nodes' : 'deleted nothing',
    !missing.length && !extra.length,
    [missing.length && `kept ${missing.join(', ')}`, extra.length && `also deleted ${extra.join(', ')}`].filter(Boolean).join('; '),
  );

  // Merges: count, and each group is covered by one surviving merge node.
  const groups = e.merged ?? [];
  const wantCount = e.mergeCount ?? groups.reduce((sum, g) => sum + g.length - 1, 0);
  add(`created ${wantCount} merge${wantCount === 1 ? '' : 's'}`, o.merges.length === wantCount, `created ${o.merges.length}`);
  if (groups.length) {
    const final = buildIndex(o.nodes);
    const mergeIds = o.merges.map((m) => m.id).filter((id) => final.byId.has(id));
    for (const g of groups) {
      const ok = mergeIds.some((m) => {
        const anc = ancestorIds(final, m);
        return g.every((id) => anc.has(id));
      });
      const got = o.merges.map((m) => m.parents.join('+')).join(', ') || 'none';
      add(`merged ${g.join(' + ')}`, ok, `merges: ${got}`);
    }
  }
  if (e.instruction) {
    const got = o.merges.map((m) => m.instruction ?? '');
    add('merge instruction', got.some((i) => e.instruction!.test(i)), `instructions: ${JSON.stringify(got)}`);
  }

  // Reply text.
  add('reply not empty', o.reply.trim().length > 0);
  const handle = /\bn\d+\b/.exec(o.reply);
  add('no handles in reply', !handle, handle ? `found "${handle[0]}"` : undefined);
  for (const re of e.replyMatches ?? []) add(`reply matches ${re}`, re.test(o.reply), excerpt(o.reply));
  for (const re of e.replyNot ?? []) {
    const m = re.exec(o.reply);
    add(`reply avoids ${re}`, !m, m ? `found "${m[0]}"` : undefined);
  }

  // Tool hygiene: invalid calls are recoverable but signal confusion (bad handle, invalid merge).
  const failed = o.steps.filter((s) => !s.ok);
  add('no failed tool calls', !failed.length, failed.map((s) => s.text).join('; '));
  return checks;
}

const excerpt = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `"${t.slice(0, max - 1)}…"` : `"${t}"`;
};

/** Text the judge sees: what the user asked, what changed, and the reply. */
export function judgePrompt(c: EvalCase, o: Outcome): { system: string; user: string } {
  const tree = buildTree(c)
    .filter((n) => n.id !== ASK_ID && n.kind !== 'root')
    .map((n) => `- ${n.id} (parent ${n.parentIds.join('+')}): user "${n.userMessage}" / assistant "${n.assistantMessage}"`)
    .join('\n');
  const actions = o.steps.map((s) => `- ${s.ok ? 'OK' : 'FAILED'}: ${s.text}`).join('\n') || '- none';
  return {
    system:
      'You grade replies from a chat assistant that can merge and delete branches of a conversation tree. ' +
      'Judge only against the rubric. Respond with a single JSON object: {"pass": true|false, "reason": "<one sentence>"}.',
    user:
      `Conversation tree (ids are internal; the user never sees them):\n${tree}\n\n` +
      `The user is writing in a new message under ${c.ask.parent} and says:\n"${c.ask.user}"\n\n` +
      `Tree actions the assistant took:\n${actions}\n\nAssistant reply:\n"""\n${o.reply}\n"""\n\nRubric: ${c.expect.rubric}`,
  };
}

export function parseVerdict(raw: string): Check {
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const v = JSON.parse(m?.[0] ?? '') as { pass?: unknown; reason?: unknown };
    if (typeof v.pass !== 'boolean') throw new Error();
    return { name: 'judge', pass: v.pass, ...(!v.pass && { detail: String(v.reason ?? '') }) };
  } catch {
    return { name: 'judge', pass: false, detail: `unparseable verdict: ${raw.slice(0, 120)}` };
  }
}
