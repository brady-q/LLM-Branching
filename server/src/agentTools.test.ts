import { beforeEach, describe, expect, test } from 'vitest';
import type { ChatNode, NodeId } from '@llmb/shared';
import { executeTool, handleScrubber, Handles, type TreeOps } from './agentTools';

let clock = 0;
const base = { treeId: 't', userMessage: '', assistantMessage: '' };
const root = (id: string): ChatNode => ({ ...base, id, parentIds: [], kind: 'root', status: 'root', createdAt: clock++ });
const chat = (id: string, parent: string, status: ChatNode['status'] = 'done'): ChatNode => ({
  ...base, id, parentIds: [parent], kind: 'chat', userMessage: `q:${id}`,
  assistantMessage: status === 'done' ? `a:${id}` : '', status, createdAt: clock++,
});

/** In-memory tree; records what the tools did. */
function fakeTree(nodes: ChatNode[], mergeStatus: ChatNode['status'] = 'done') {
  let all = [...nodes];
  const merges: [NodeId, NodeId, string | undefined][] = [];
  const removed: NodeId[][] = [];
  const ops: TreeOps = {
    nodes: () => all,
    merge: async (a, b, instruction) => {
      merges.push([a, b, instruction]);
      const m: ChatNode = {
        ...base, id: `m${merges.length}`, parentIds: [a, b], kind: 'merge', status: mergeStatus,
        assistantMessage: mergeStatus === 'done' ? 'summary' : '', createdAt: clock++,
        ...(mergeStatus === 'error' && { error: 'boom' }),
      };
      all = [...all, m];
      return m;
    },
    remove: (ids) => {
      removed.push(ids);
      all = all.filter((n) => !ids.includes(n.id));
    },
  };
  return { ops, merges, removed, handles: new Handles(all) };
}

// root(n1) ─ a(n2) ─ b(n3)
//          └ c(n4) ─ d(n5)
//          └ e(n6, streaming)
let tree: ReturnType<typeof fakeTree>;
beforeEach(() => {
  tree = fakeTree([root('r'), chat('a', 'r'), chat('b', 'a'), chat('c', 'r'), chat('d', 'c'), chat('e', 'r', 'streaming')]);
});
const run = (name: string, args: unknown) =>
  executeTool(name, typeof args === 'string' ? args : JSON.stringify(args), tree.ops, tree.handles);

describe('Handles', () => {
  test('numbers nodes by creation order and accepts loose spellings', () => {
    expect(tree.handles.of('r')).toBe('n1');
    expect(tree.handles.of('d')).toBe('n5');
    expect(tree.handles.resolve('n3')).toBe('b');
    expect(tree.handles.resolve(' N3 ')).toBe('b');
    expect(tree.handles.resolve('3')).toBe('b');
    expect(tree.handles.resolve('n99')).toBeUndefined();
    expect(tree.handles.resolve('b')).toBeUndefined(); // raw ids are not accepted
    expect(tree.handles.resolve(3)).toBeUndefined();
  });
});

describe('read tools', () => {
  test('outline lists every node with handles and parents', async () => {
    const r = await run('get_tree_outline', {});
    expect(r.ok).toBe(true);
    expect(r.result.split('\n')).toHaveLength(6);
    expect(r.result).toContain('n3 chat done parents=n2 children=0');
  });

  test('get_node returns full text; unknown handle is an error', async () => {
    expect((await run('get_node', { node: 'n3' })).result).toContain('a:b');
    expect((await run('get_node', { node: 'n42' })).ok).toBe(false);
  });
});

describe('merge_nodes', () => {
  test('merges two valid branch tips and trims the instruction', async () => {
    const r = await run('merge_nodes', { a: 'n3', b: 'n5', instruction: '  keep code  ' });
    expect(r.ok).toBe(true);
    expect(tree.merges).toEqual([['b', 'd', 'keep code']]);
    expect(r.action).toEqual({ type: 'merge', nodeId: 'm1', parentIds: ['b', 'd'] });
    expect(r.summary).toBe('Merged "q:b" + "q:d"');
  });

  test.each([
    [{ a: 'n3', b: 'n3' }, 'itself'],
    [{ a: 'n2', b: 'n3' }, 'contains the other'],
    [{ a: 'n3', b: 'n6' }, 'finished reply'],
    [{ a: 'n1', b: 'n3' }, 'finished reply'], // root has no reply
    [{ a: 'n3', b: 'nope' }, 'unknown node'],
    [{ a: 'n3', b: 'n5', instruction: 5 }, 'instruction must be a string'],
  ])('rejects %j without changing the tree', async (args, reason) => {
    const r = await run('merge_nodes', args);
    expect(r.ok).toBe(false);
    expect(r.result).toContain(reason);
    expect(tree.merges).toEqual([]);
  });

  test('a merge result can itself be merged in a later call', async () => {
    await run('merge_nodes', { a: 'n3', b: 'n5' });
    tree.ops.nodes().push(chat('f', 'r'));
    const r = await run('merge_nodes', { a: 'n7', b: tree.handles.of('f') });
    expect(r.ok).toBe(true);
    expect(tree.merges[1]).toEqual(['m1', 'f', undefined]);
  });

  test('reports a failed summary', async () => {
    tree = fakeTree([root('r'), chat('a', 'r'), chat('b', 'r')], 'error');
    const r = await run('merge_nodes', { a: 'n2', b: 'n3' });
    expect(r.ok).toBe(false);
    expect(r.action?.type).toBe('merge');
    expect(r.result).toContain('boom');
  });
});

describe('delete_node', () => {
  test('deletes the node and its descendants', async () => {
    const r = await run('delete_node', { node: 'n4' });
    expect(r.ok).toBe(true);
    expect(tree.removed).toEqual([['c', 'd']]);
    expect(r.summary).toBe('Deleted "q:c" and 1 node below it');
    expect((await run('get_node', { node: 'n4' })).ok).toBe(false); // gone afterwards
  });

  test('refuses to delete the conversation the reply is in', async () => {
    // Reply being written is d (n5); its chain is r, c, d.
    const r = await executeTool('delete_node', JSON.stringify({ node: 'n4' }), tree.ops, tree.handles, new Set(['r', 'c', 'd']));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('current conversation');
    expect(tree.removed).toEqual([]);
    // Other branches are fine.
    const ok = await executeTool('delete_node', JSON.stringify({ node: 'n2' }), tree.ops, tree.handles, new Set(['r', 'c', 'd']));
    expect(ok.ok).toBe(true);
  });

  test('refuses the root and unknown nodes', async () => {
    expect((await run('delete_node', { node: 'n1' })).result).toContain('n1 is the root');
    expect((await run('delete_node', { node: 'n77' })).ok).toBe(false);
    expect(tree.removed).toEqual([]);
  });
});

test('malformed arguments and unknown tools are errors, not crashes', async () => {
  expect((await run('delete_node', '{not json')).ok).toBe(false);
  expect((await run('delete_node', '[1,2]')).ok).toBe(false);
  expect((await run('drop_database', {})).result).toContain('Unknown tool');
  expect(tree.removed).toEqual([]);
});

describe('handleScrubber', () => {
  const scrubAll = (pieces: string[]) => {
    const s = handleScrubber(tree.handles, (id) => `<${id}>`);
    return pieces.map((p) => s.push(p)).join('') + s.flush();
  };

  test('replaces known handles, even split across pieces', () => {
    expect(scrubAll(['The branch n3 and `n5`.'])).toBe('The branch <b> and `<d>`.');
    expect(scrubAll(['see n', '3', ' then n', '5'])).toBe('see <b> then <d>');
    expect(scrubAll(['(n2 → n', '3 →', ' n4)'])).toBe('(<a> → <b> → <c>)');
  });

  test('leaves other text alone', () => {
    expect(scrubAll(['wear an N95 or n95; open in', ' n99 and in3 now'])).toBe('wear an N95 or n95; open in n99 and in3 now');
    expect(scrubAll(['plain text'])).toBe('plain text');
    expect(scrubAll(['ends in n'])).toBe('ends in n');
  });
});
