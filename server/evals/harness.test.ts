import { describe, expect, test } from 'vitest';
import { contextChain, buildIndex } from '@llmb/shared';
import { executeTool, Handles } from '../src/agentTools';
import { CASES } from './cases';
import { buildTree, grade, parseVerdict, runCase, type ChatTurnFn, type EvalCase } from './harness';

/**
 * Tests for the eval harness itself, with scripted "models" that call the real
 * tools. The point: a correct script passes every check, a wrong one fails the
 * right check. Real-model evals run with `npm run eval`.
 */

/** Script: a list of [tool, args] calls by handle, then a reply. */
const script =
  (calls: [string, Record<string, string>][], reply: string): ChatTurnFn =>
  async ({ node, ops, onStep }) => {
    const handles = new Handles(ops.nodes());
    const protectedIds = new Set(contextChain(buildIndex(ops.nodes()), node.id).map((n) => n.id));
    for (const [name, args] of calls) {
      const r = await executeTool(name, JSON.stringify(args), ops, handles, protectedIds);
      if (r.action || !r.ok) onStep({ text: r.summary, ok: r.ok });
    }
    return reply;
  };

const get = (name: string) => CASES.find((c) => c.name === name)!;
const failures = async (c: EvalCase, turn: ChatTurnFn) =>
  grade(c, await runCase(c, turn)).filter((x) => !x.pass).map((x) => x.name);

// Dinner tree handles: root n1, dinner n2, pasta1 n3, pasta2 n4, pizza1 n5, pizza2 n6, salad1 n7, ask n8.

describe('cases', () => {
  test('every case builds a valid tree', () => {
    for (const c of CASES) {
      const nodes = buildTree(c);
      expect(() => contextChain(buildIndex(nodes), 'ask'), c.name).not.toThrow();
    }
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});

describe('grade', () => {
  test('correct merge passes', async () => {
    const turn = script([['merge_nodes', { a: 'n4', b: 'n6' }]], 'Merged the pasta and pizza branches.');
    expect(await failures(get('merge-two-branches'), turn)).toEqual([]);
  });

  test('merging the wrong branches fails', async () => {
    const turn = script([['merge_nodes', { a: 'n4', b: 'n7' }]], 'Done.');
    expect(await failures(get('merge-two-branches'), turn)).toEqual(['merged pasta2 + pizza2']);
  });

  test('three-way merge needs two pairwise merges covering all three', async () => {
    const c = get('merge-three-branches');
    const good = script([['merge_nodes', { a: 'n4', b: 'n6' }], ['merge_nodes', { a: 'n9', b: 'n7' }]], 'Merged all three.');
    expect(await failures(c, good)).toEqual([]);
    const half = script([['merge_nodes', { a: 'n4', b: 'n6' }]], 'Merged.');
    expect(await failures(c, half)).toEqual(['created 2 merges', 'merged pasta2 + pizza2 + salad1']);
  });

  test('merge instruction is checked', async () => {
    const c = get('merge-with-instruction');
    const without = script([['merge_nodes', { a: 'n4', b: 'n6' }]], 'Merged.');
    expect(await failures(c, without)).toEqual(['merge instruction']);
    const withIt = script([['merge_nodes', { a: 'n4', b: 'n6', instruction: 'focus on the shopping list' }]], 'Merged.');
    expect(await failures(c, withIt)).toEqual([]);
  });

  test('deleting the split point instead of the branch fails', async () => {
    const c = get('delete-branch');
    expect(await failures(c, script([['delete_node', { node: 'n5' }]], 'Deleted the pizza branch.'))).toEqual([]);
    // Deleting the leaf only leaves pizza1 behind.
    expect(await failures(c, script([['delete_node', { node: 'n6' }]], 'Deleted.'))).toEqual(['deleted the right nodes']);
  });

  test('no-change cases fail on any change, handle leaks and failed calls', async () => {
    const c = get('missing-target');
    expect(await failures(c, script([], 'There is no taco branch, so I left everything as is.'))).toEqual([]);
    expect(await failures(c, script([['delete_node', { node: 'n5' }]], 'Deleted.'))).toEqual(['deleted nothing']);
    expect(await failures(c, script([], 'I checked n5 and n7.'))).toEqual(['no handles in reply']);
    expect(await failures(c, script([['delete_node', { node: 'n99' }]], 'Nothing found.'))).toEqual(['no failed tool calls']);
  });

  test('protected delete is refused by the tools and graded as no change', async () => {
    const c = get('delete-own-conversation');
    const turn = script([['delete_node', { node: 'n3' }]], "I can't delete the branch you're in.");
    // The refusal shows up as a failed call; that's the expected path only if the model tries.
    expect(await failures(c, turn)).toEqual(['no failed tool calls']);
  });

  test('reply patterns', async () => {
    const c = get('read-other-branch');
    expect(await failures(c, script([], 'About 48 hours in the fridge.'))).toEqual([]);
    expect(await failures(c, script([], 'A few hours.'))).toEqual(['reply matches /48/']);
  });

  test('a thrown error is a single failed check', async () => {
    const c = get('read-other-branch');
    const checks = grade(c, await runCase(c, async () => { throw new Error('boom'); }));
    expect(checks).toEqual([{ name: 'no error', pass: false, detail: 'boom' }]);
  });
});

describe('parseVerdict', () => {
  test('reads JSON, tolerates surrounding text, rejects junk', () => {
    expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ name: 'judge', pass: true });
    expect(parseVerdict('Sure:\n```json\n{"pass": false, "reason": "claimed success"}\n```')).toEqual({
      name: 'judge', pass: false, detail: 'claimed success',
    });
    expect(parseVerdict('yes').pass).toBe(false);
  });
});
