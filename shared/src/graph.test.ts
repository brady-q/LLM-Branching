import { describe, expect, test } from 'vitest';
import {
  ancestorIds,
  buildContext,
  buildIndex,
  buildMergeRequest,
  canBranchFrom,
  contextChain,
  descendantIds,
  GraphError,
  mergeInputs,
  mergeUserMessage,
  validateMerge,
} from './graph';
import type { ChatNode } from './types';

let clock = 0;

function root(id = 'root'): ChatNode {
  return {
    id, treeId: 't', parentIds: [], kind: 'root',
    userMessage: '', assistantMessage: '', status: 'root', createdAt: clock++,
  };
}

function chat(id: string, parent: string, status: ChatNode['status'] = 'done'): ChatNode {
  return {
    id, treeId: 't', parentIds: [parent], kind: 'chat',
    userMessage: `q:${id}`, assistantMessage: status === 'done' ? `a:${id}` : '',
    status, createdAt: clock++,
  };
}

function merge(id: string, a: string, b: string, status: ChatNode['status'] = 'done'): ChatNode {
  return {
    id, treeId: 't', parentIds: [a, b], kind: 'merge',
    userMessage: `merge:${id}`, assistantMessage: status === 'done' ? `summary:${id}` : '',
    status, createdAt: clock++,
  };
}

const ids = (nodes: ChatNode[]) => nodes.map((n) => n.id);

/**
 *        root
 *        /   \
 *       A     X
 *      / \
 *     B   C
 *     |   |
 *     D   E
 *      \ /
 *       M        (merge of D and E, split point A)
 *       |
 *       F
 */
function sample() {
  return buildIndex([
    root(), chat('A', 'root'), chat('X', 'root'),
    chat('B', 'A'), chat('C', 'A'), chat('D', 'B'), chat('E', 'C'),
    merge('M', 'D', 'E'), chat('F', 'M'),
  ]);
}

describe('buildIndex', () => {
  test('children are derived and sorted oldest first', () => {
    const idx = sample();
    expect(idx.children.get('root')).toEqual(['A', 'X']);
    expect(idx.children.get('A')).toEqual(['B', 'C']);
    expect(idx.children.get('D')).toEqual(['M']);
    expect(idx.children.get('E')).toEqual(['M']);
    expect(idx.children.get('F')).toEqual([]);
  });
});

describe('contextChain', () => {
  test('root alone', () => {
    expect(ids(contextChain(sample(), 'root'))).toEqual(['root']);
  });

  test('plain branch walks parents to root', () => {
    expect(ids(contextChain(sample(), 'D'))).toEqual(['root', 'A', 'B', 'D']);
  });

  test('siblings never see each other', () => {
    const idx = sample();
    expect(ids(contextChain(idx, 'E'))).not.toContain('B');
    expect(ids(contextChain(idx, 'D'))).not.toContain('C');
  });

  test('merge node = shared prefix + merge, no branch content', () => {
    const idx = sample();
    expect(ids(contextChain(idx, 'M'))).toEqual(['root', 'A', 'M']);
    expect(ids(contextChain(idx, 'F'))).toEqual(['root', 'A', 'M', 'F']);
  });

  test('merge of nodes whose only shared ancestor is root', () => {
    const idx = buildIndex([root(), chat('A', 'root'), chat('B', 'root'), merge('M', 'A', 'B')]);
    expect(ids(contextChain(idx, 'M'))).toEqual(['root', 'M']);
  });

  test('nested merge and merge of a merge with a plain branch', () => {
    const idx = buildIndex([
      root(), chat('A', 'root'), chat('B', 'A'), chat('C', 'A'),
      merge('M1', 'B', 'C'), chat('D', 'M1'),
      chat('E', 'root'),
      merge('M2', 'D', 'E'), chat('G', 'M2'),
      chat('H', 'M1'),
      merge('M3', 'D', 'H'),
    ]);
    // M2: D's chain is root,A,M1,D ; E's chain is root,E -> shared = root
    expect(ids(contextChain(idx, 'G'))).toEqual(['root', 'M2', 'G']);
    // M3: D and H both descend from M1 -> shared = root,A,M1
    expect(ids(contextChain(idx, 'M3'))).toEqual(['root', 'A', 'M1', 'M3']);
  });

  test('very deep chain does not overflow', () => {
    const nodes = [root()];
    for (let i = 0; i < 5000; i++) nodes.push(chat(`n${i}`, i === 0 ? 'root' : `n${i - 1}`));
    const chain = contextChain(buildIndex(nodes), 'n4999');
    expect(chain).toHaveLength(5001);
    expect(chain[0]!.id).toBe('root');
  });

  test('unknown node and malformed graphs throw', () => {
    const idx = sample();
    expect(() => contextChain(idx, 'nope')).toThrow(GraphError);
    const cyc = buildIndex([chat('a', 'b'), chat('b', 'a')]);
    expect(() => contextChain(cyc, 'a')).toThrow(/Cycle/);
    const orphan = buildIndex([chat('a', 'missing')]);
    expect(() => contextChain(orphan, 'a')).toThrow(GraphError);
  });
});

describe('buildContext', () => {
  test('sending from root gives a single user message', () => {
    const idx = buildIndex([root(), chat('N', 'root', 'streaming')]);
    expect(buildContext(contextChain(idx, 'N'))).toEqual([{ role: 'user', content: 'q:N' }]);
  });

  test('alternates user/assistant and ends on the new user turn', () => {
    const idx = buildIndex([root(), chat('A', 'root'), chat('B', 'A', 'streaming')]);
    expect(buildContext(contextChain(idx, 'B'))).toEqual([
      { role: 'user', content: 'q:A' },
      { role: 'assistant', content: 'a:A' },
      { role: 'user', content: 'q:B' },
    ]);
  });

  test('below a merge: prefix, merge summary, then new turn', () => {
    const idx = sample();
    idx.byId.set('N', chat('N', 'F', 'streaming'));
    idx.children.get('F')!.push('N');
    expect(buildContext(contextChain(idx, 'N')).map((m) => m.content)).toEqual([
      'q:A', 'a:A', 'merge:M', 'summary:M', 'q:F', 'a:F', 'q:N',
    ]);
  });

  test('successful tool actions are noted before the reply; failed ones are not', () => {
    const a = { ...chat('A', 'root'), actions: [{ text: 'Merged x + y', ok: true }, { text: 'nope', ok: false }] };
    const idx = buildIndex([root(), a, chat('B', 'A', 'streaming')]);
    expect(buildContext(contextChain(idx, 'B'))[1]?.content).toBe('[Actions I took: Merged x + y]\n\na:A');
  });

  test('an unfinished ancestor makes turns collide and throws', () => {
    const idx = buildIndex([root(), chat('A', 'root', 'error'), chat('B', 'A', 'streaming')]);
    expect(() => buildContext(contextChain(idx, 'B'))).toThrow(GraphError);
  });
});

describe('canBranchFrom', () => {
  test('only root and done nodes', () => {
    expect(canBranchFrom(root())).toBe(true);
    expect(canBranchFrom(chat('a', 'root'))).toBe(true);
    expect(canBranchFrom(chat('b', 'root', 'streaming'))).toBe(false);
    expect(canBranchFrom(chat('c', 'root', 'error'))).toBe(false);
  });
});

describe('ancestors / descendants', () => {
  test('ancestorIds follows both merge parents', () => {
    expect([...ancestorIds(sample(), 'M')].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'root']);
  });

  test('deleting one merge parent takes the merge and everything below it', () => {
    const idx = sample();
    expect(descendantIds(idx, 'D').sort()).toEqual(['F', 'M']);
    expect(descendantIds(idx, 'C').sort()).toEqual(['E', 'F', 'M']);
  });

  test('descendants are unique when reachable via two paths', () => {
    const idx = sample();
    const d = descendantIds(idx, 'A');
    expect(d.sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'M']);
    expect(new Set(d).size).toBe(d.length);
  });

  test('sibling branches are untouched', () => {
    expect(descendantIds(sample(), 'A')).not.toContain('X');
  });
});

describe('validateMerge', () => {
  const idx = sample();
  test('valid divergent branches', () => {
    expect(validateMerge(idx, 'D', 'E')).toEqual({ ok: true });
    expect(validateMerge(idx, 'F', 'X')).toEqual({ ok: true });
  });
  test('rejections', () => {
    expect(validateMerge(idx, 'D', 'D').ok).toBe(false);
    expect(validateMerge(idx, 'A', 'D').ok).toBe(false); // ancestor
    expect(validateMerge(idx, 'F', 'B').ok).toBe(false); // ancestor through a merge
    expect(validateMerge(idx, 'root', 'X').ok).toBe(false); // root not 'done'
    expect(validateMerge(idx, 'D', 'nope').ok).toBe(false);
  });
  test('unfinished node', () => {
    const i2 = buildIndex([root(), chat('A', 'root'), chat('B', 'root', 'streaming')]);
    expect(validateMerge(i2, 'A', 'B').ok).toBe(false);
  });
  test('different trees', () => {
    const other = { ...chat('Z', 'root'), treeId: 'other' };
    const i2 = buildIndex([root(), chat('A', 'root'), other]);
    expect(validateMerge(i2, 'A', 'Z').ok).toBe(false);
  });
});

describe('mergeInputs / buildMergeRequest', () => {
  test('splits into shared prefix and two segments', () => {
    const m = mergeInputs(sample(), 'D', 'E');
    expect(ids(m.shared)).toEqual(['root', 'A']);
    expect(ids(m.segments[0])).toEqual(['B', 'D']);
    expect(ids(m.segments[1])).toEqual(['C', 'E']);
  });

  test('a segment passing through an earlier merge includes its summary', () => {
    const m = mergeInputs(sample(), 'F', 'X');
    expect(ids(m.shared)).toEqual(['root']);
    expect(ids(m.segments[0])).toEqual(['A', 'M', 'F']);
  });

  test('request contains tagged branches and instruction', () => {
    const req = buildMergeRequest(mergeInputs(sample(), 'D', 'E'), 'focus on code');
    expect(req.messages).toHaveLength(1);
    const text = req.messages[0]!.content;
    expect(text).toMatch(/<branch_a>\n[\s\S]*q:B[\s\S]*a:D[\s\S]*<\/branch_a>/);
    expect(text).toMatch(/<branch_b>\n[\s\S]*q:C[\s\S]*a:E[\s\S]*<\/branch_b>/);
    expect(text).toMatch(/<shared_context>\n[\s\S]*q:A/);
    expect(text).not.toMatch(/<branch_a>[\s\S]*q:C[\s\S]*<\/branch_a>/);
    expect(text).toContain('focus on code');
  });

  test('over budget: trims oldest text, keeps newest', () => {
    const big = (id: string, parent: string): ChatNode => ({
      ...chat(id, parent), userMessage: `${id}-start ${'x'.repeat(5000)} ${id}-end`,
    });
    const idx = buildIndex([root(), big('A', 'root'), big('B', 'root')]);
    const text = buildMergeRequest(mergeInputs(idx, 'A', 'B'), undefined, 4000).messages[0]!.content;
    expect(text).toContain('earlier content omitted');
    expect(text).toContain('A-end');
    expect(text).not.toContain('A-start');
    expect(text.length).toBeLessThan(6000);
  });

  test('mergeUserMessage labels both sides', () => {
    const idx = sample();
    const msg = mergeUserMessage(idx.byId.get('D')!, idx.byId.get('M')!, 'keep it short');
    expect(msg).toBe('Merge our two branches: "q:D" and an earlier merge. keep it short');
  });
});
