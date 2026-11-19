# LLM Branching

A ChatGPT-style chat where the conversation is a graph. Go back to any earlier message and send a new one to start a branch. Merge two branches into a new node that has an AI summary of both.

## Run

```bash
npm install
cp .env.example .env   # then set OPENROUTER_API_KEY
npm run dev            # server :8787, client http://localhost:5173
```

Set `MOCK_LLM=1` in `.env` to try the app without API calls: replies are fake echoes of the context the model would see.

Other commands: `npm test` (graph logic tests), `npm run typecheck`.

## Using it

- **Branch:** click any message (in the chat or the graph), then send a message. It becomes a new child of that node.
- **Merge:** select a node, click **⑂ Merge with…**, then click a second node in the graph. The new node sits below both and holds a summary of what each branch added after they split.
- **Delete:** removes a node and everything below it, including merges that depend on it.
- **Ask the assistant:** in normal chat you can say "merge the pasta and taco branches" or "delete the branch about X". It acts on its own and lists what it did above its reply. It can't delete the conversation you're in (switch to another branch first).

## How the assistant edits the tree

Every chat reply runs as a tool-calling loop (`server/src/agent.ts`, max 8 tool rounds), streamed into the same node. Tools: `get_tree_outline`, `get_node`, `merge_nodes`, `delete_node`. The model sees an outline of the tree with short handles (`n1`, `n2`, …) instead of UUIDs. Every call is checked in `server/src/agentTools.ts` against the same rules as the UI (node exists in this tree, `validateMerge`, root can't be deleted) plus one more: the reply can't delete its own conversation. Invalid calls change nothing; the error goes back to the model so it can correct itself. Merges run in order and wait for their summary, so a merge result can be merged again (3+ branches). Each reply's actions are saved on its node (`actions`) and included in later context. Tests: `server/src/agentTools.test.ts`. With `MOCK_LLM=1` the assistant understands `merge n2 and n3` / `delete n4`.

## How context works

Each node is one exchange (your message plus the reply). The model sees one linear history per node:

- a normal node: its parent's history, then itself
- a merge node: the history both branches share up to the split, then the merge summary

The logic lives in `shared/src/graph.ts` and is covered by `shared/src/graph.test.ts`. See `PLAN.md` for the full design.

## Layout

```
shared/   types + pure graph logic (tested)
server/   Hono API, SQLite (better-sqlite3), OpenRouter streaming over SSE
client/   React + Vite, Zustand store, React Flow + dagre graph
```

## Config (`.env`)

| Var | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | | required unless `MOCK_LLM=1` |
| `CHAT_MODEL` | `deepseek/deepseek-v4-flash` | any OpenRouter model id; must support tool calling |
| `MERGE_MODEL` | `deepseek/deepseek-v4-flash` | model for merge summaries |
| `DB_PATH` | `./data.db` | SQLite file, relative to repo root |
| `PORT` | `8787` | API server port |
| `MOCK_LLM` | `0` | `1` = fake replies, no API calls |
