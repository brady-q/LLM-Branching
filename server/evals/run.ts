/**
 * Run the assistant evals against a real model (needs OPENROUTER_API_KEY).
 *
 *   npm run eval                          # all cases, 3 trials each
 *   npm run eval -- --filter delete       # cases whose name or tag contains "delete"
 *   npm run eval -- --model openai/gpt-5-mini --trials 5
 *   npm run eval -- --no-judge            # deterministic checks only
 *
 * Results are printed and saved to eval-results/<timestamp>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    trials: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    filter: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

// Before the server modules load: never touch the real DB, never use the mock model.
const dbPath = join(tmpdir(), `llmb-eval-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.MOCK_LLM = '0';
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
});

const { runChatTurn } = await import('../src/agent');
const { config } = await import('../src/config');
const { streamTurn } = await import('../src/llm');
const { CASES } = await import('./cases');
const { grade, judgePrompt, parseVerdict, runCase } = await import('./harness');
type Check = import('./harness').Check;
type Outcome = import('./harness').Outcome;

if (!config.openrouterApiKey) {
  console.error('OPENROUTER_API_KEY is not set (.env). Evals need a real model.');
  process.exit(1);
}

const model = args.model ?? config.chatModel;
const judgeModel = args['judge-model'] ?? model;
const trials = Math.max(1, Number(args.trials));
const concurrency = Math.max(1, Number(args.concurrency));
const useJudge = !args['no-judge'];
const filter = args.filter?.toLowerCase();
const cases = CASES.filter((c) => !filter || c.name.includes(filter) || c.tags.some((t) => t.includes(filter)));
if (!cases.length) {
  console.error(`No cases match "${args.filter}".`);
  process.exit(1);
}

async function judge(c: (typeof cases)[number], o: Outcome): Promise<Check> {
  const p = judgePrompt(c, o);
  try {
    const turn = await streamTurn(
      { model: judgeModel, system: p.system, messages: [{ role: 'user', content: p.user }] },
      () => {},
      AbortSignal.timeout(60_000),
    );
    return parseVerdict(turn.text);
  } catch (err) {
    return { name: 'judge', pass: false, detail: `judge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface Trial {
  case: string;
  trial: number;
  pass: boolean;
  checks: Check[];
  reply: string;
  steps: Outcome['steps'];
  ms: number;
}

async function runTrial(c: (typeof cases)[number], trial: number): Promise<Trial> {
  const o = await runCase(c, ({ node, ops, onToken, onStep }) =>
    runChatTurn({ node, ops, model, onToken, onStep, emit: () => {}, signal: AbortSignal.timeout(180_000) }),
  );
  const checks = grade(c, o);
  if (useJudge && c.expect.rubric && !o.error) checks.push(await judge(c, o));
  return { case: c.name, trial, pass: checks.every((x) => x.pass), checks, reply: o.reply, steps: o.steps, ms: o.ms };
}

// Simple worker pool over (case, trial) pairs.
const jobs = cases.flatMap((c) => Array.from({ length: trials }, (_, i) => () => runTrial(c, i + 1)));
const results: Trial[] = [];
let next = 0;
let finished = 0;
console.log(`Model ${model}${useJudge ? `, judge ${judgeModel}` : ''}: ${cases.length} cases × ${trials} trials\n`);
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const r = await jobs[next++]!();
      results.push(r);
      finished++;
      process.stdout.write(`\r${finished}/${jobs.length} done`);
    }
  }),
);
process.stdout.write('\n\n');

// Report: one line per case, then failure details.
const width = Math.max(...cases.map((c) => c.name.length));
let passedTrials = 0;
for (const c of cases) {
  const rs = results.filter((r) => r.case === c.name).sort((a, b) => a.trial - b.trial);
  const passed = rs.filter((r) => r.pass).length;
  passedTrials += passed;
  const avg = rs.reduce((s, r) => s + r.ms, 0) / rs.length / 1000;
  const mark = passed === rs.length ? 'PASS' : passed ? 'FLAKY' : 'FAIL';
  console.log(`${mark.padEnd(5)}  ${c.name.padEnd(width)}  ${passed}/${rs.length}  ${avg.toFixed(1)}s  [${c.tags.join(', ')}]`);
  for (const r of rs) {
    const failed = r.checks.filter((x) => !x.pass);
    if (!failed.length && !args.verbose) continue;
    console.log(`         trial ${r.trial}:`);
    for (const f of failed) console.log(`           ✗ ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    if (args.verbose || failed.length) {
      for (const s of r.steps) console.log(`           · ${s.ok ? '' : '[failed] '}${s.text}`);
      console.log(`           reply: ${JSON.stringify(r.reply.slice(0, 300))}`);
    }
  }
}
const total = results.length;
console.log(`\n${passedTrials}/${total} trials passed (${((passedTrials / total) * 100).toFixed(0)}%)`);

const outDir = new URL('../../eval-results/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const file = new URL(`${new Date().toISOString().replace(/[:.]/g, '-')}.json`, outDir);
writeFileSync(file, JSON.stringify({ model, judgeModel: useJudge ? judgeModel : null, trials, results }, null, 2));
console.log(`Saved ${file.pathname}`);
process.exit(passedTrials === total ? 0 : 1);
