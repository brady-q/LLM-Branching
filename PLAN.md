# Branching LLM Chat: MVP Plan

## 1. What the reference app (TreeLM / gptree) actually does

Found by reading its production JS bundle:

- **Stack:** React, Vite, Tailwind, Radix UI, **React Flow (`@xyflow/react`)** for the canvas, **Zustand** store, Firebase (Auth: anonymous + Google; Firestore: one doc per "workspace" holding `{nodes, edges}`, autosaved with a 1s debounce). LLM calls go to OpenAI, Anthropic and Gemini, and you pick the model per question.
- **Node model:** each node has a `type`:
  - `root`: empty starting node.
  - `ai`: one exchange. It holds `content` (the user prompt), `responseContent` (the model reply), `model`, `parentNodeId`, a `title`, and `displayingContent`. The title and short summary are written by a cheap model after the reply finishes.
  - `loadingNode`: placeholder while a reply streams in.
  - Edges join parent to child, and the edge label shows the question that was asked.
- **Branching:** you click any node and ask a question. The new node becomes a child of the clicked node. Asking twice from the same node gives siblings, and that is a branch. There is no separate "branch" command.
- **Context:** `Sg(nodeId, nodes, edges)` walks parent links from the selected node up to the root and returns the path. The path is used to (a) highlight ancestor nodes and edges, and (b) build the message history sent to the LLM. Sibling branches are never included.
- **Extras (out of scope here):** node summaries, multiple models, workspaces, tiers and payments, node limits, read/unread markers, i18n.

**Core idea to copy:** the conversation is a graph of exchanges. The context for a new message is built from the selected node's ancestry. Everything else is UI.

## 2. MVP scope

In:
1. A graph that starts from a single root node.
2. Select any node, send a message, and a child node is created with a streamed reply. Branching is just sending from a node that already has children.
3. **Merge two nodes.** The result is a new node placed **below both of them, with both as its parents**. Its content is an AI summary of what each branch covered since they split. You can keep chatting from it.
4. Chat panel: a ChatGPT-style linear view of the selected node's context.
5. Graph panel: every node, auto-laid-out. Clicking a node selects it. The context path is highlighted.
6. Persistence across reloads, plus a simple list of trees (new / open / delete).
7. **Delete a node and everything below it**, including any merge nodes that have it as a parent, and their descendants.
8. Clear error state on a node, with a retry button.

Out (later): auto-titles, multi-model, auth (section 11 keeps that door open), sharing, editing messages in place, merging 3+ nodes at once (the schema allows it), context-window trimming, drag-to-reposition.

## 3. Architecture

```
React (Vite, TS) ──HTTP/SSE──> Node server (Hono or Express, TS) ──> Anthropic API
   │  Zustand store                 │  SQLite (better-sqlite3), behind a repository layer
   │  React Flow graph view         │  API key lives here only
   │  Chat panel                    │
```

- The **server is needed** so the API key never reaches the browser. It also gives durable storage that survives a cleared browser.
- **LLM provider** sits behind one function, `streamChat(messages, opts, onToken, signal)`, so the provider can be swapped. The default is the Anthropic Messages API with streaming.
- **Shared types and graph logic** live in `/shared` and are imported by both client and server.

```
/client   React app
/server   API + LLM + DB
/shared   types + pure graph logic (tested)
```

## 4. Data model

With merges the structure is no longer a tree. It is a **DAG** (directed acyclic graph): a merge node has two parents. Cycles cannot happen, because a new node can only take *existing* nodes as parents.

```ts
type NodeId = string; // uuid

interface ChatNode {
  id: NodeId;
  treeId: string;
  parentIds: NodeId[];         // root: [], chat: [p], merge: [a, b] (ordered)
  kind: 'root' | 'chat' | 'merge';
  userMessage: string;         // "" for root; for merge: the generated merge request (see 5b)
  assistantMessage: string;    // the reply; for merge: the summary
  mergeInstruction?: string;   // merge only: optional user focus, e.g. "keep the code decisions"
  status: 'root' | 'streaming' | 'done' | 'error';
  error?: string;
  model?: string;
  createdAt: number;
}

interface Tree { id: string; ownerId: string; title: string; rootId: NodeId; createdAt: number; updatedAt: number; }
```

Rules (invariants):
- **One node is one exchange** (user message plus assistant reply), as in TreeLM.
- **Nodes are append-only.** Messages never change after creation, except that `assistantMessage` fills in while `status === 'streaming'`. "Edit a prompt" or "regenerate" creates a **sibling**, so every state stays reachable.
- **Parent links are the only stored structure.** Children and edges are derived from them.
- Merging `[a, b]` is recorded in the order chosen; that order fixes which branch is "A" and which is "B" in the summary.

SQLite:
```sql
CREATE TABLE trees (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT, root_id TEXT, created_at INT, updated_at INT);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  user_message TEXT NOT NULL, assistant_message TEXT NOT NULL DEFAULT '',
  merge_instruction TEXT,
  status TEXT NOT NULL, error TEXT, model TEXT, created_at INT NOT NULL
);
CREATE TABLE node_parents (
  child_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position  INT  NOT NULL,             -- 0 for chat; 0/1 for merge
  PRIMARY KEY (child_id, parent_id)
);
CREATE INDEX trees_owner ON trees(owner_id);
CREATE INDEX nodes_tree ON nodes(tree_id);
CREATE INDEX node_parents_parent ON node_parents(parent_id);
```
Turn on `PRAGMA foreign_keys = ON`. The FK cascades only remove link rows. **Deleting descendants is done explicitly in app code** (section 5c), because a DB cascade cannot express "delete a child if *any* of its parents is deleted" through a link table.

## 5. Core logic: `/shared/graph.ts` (pure, unit-tested)

```ts
buildIndex(nodes) -> { byId, children: Map<NodeId, NodeId[]> }  // children sorted by createdAt
ancestorIds(index, id) -> Set<NodeId>        // every node reachable through parent links
contextChain(index, id) -> ChatNode[]        // the linear history the model sees (below)
buildContext(chain, systemPrompt?) -> Message[]
descendantIds(index, id) -> NodeId[]          // for delete (5c)
```

### 5a. Context chain: what the model sees

In a DAG, "the path to the root" is not unique, so we define one canonical linear history per node:

```
contextChain(root)          = [root]
contextChain(chat n, p)     = contextChain(p) + [n]
contextChain(merge m, a, b) = commonPrefix(contextChain(a), contextChain(b)) + [m]
```

- `commonPrefix` of two chains is the shared history up to the point where the branches split. Both chains start at root, so the prefix is never empty.
- The merge node itself carries the summary of everything after the split, on both sides. So below a merge, the model sees: the shared history, then the merged summary, then everything after. It does not see both branches word for word, which keeps it compact and symmetric.
- This works for **nested merges** without special cases, because a merge node is already a single entry in any chain that passes through it.
- Implementation: walk single-parent stretches in a loop, and only recurse at merge nodes (recursion depth = number of nested merges). Memoize per index.

`buildContext` turns the chain into messages. It skips root and emits `user`, `assistant` for each node. Merge nodes need no special case.

Tests:
- Sending from root gives a single user message.
- Siblings never see each other's content.
- A node under a merge sees the prefix, then the merge summary, and none of the branch messages.
- Nested merge, merge of a merge with a plain branch, and merging two nodes whose only shared ancestor is root.
- 500+ deep chain: no stack overflow.
- An ancestor with `status: 'error'` blocks sending, so the API never gets two user turns in a row.

### 5b. Merge

```ts
validateMerge(index, a, b) -> ok | reason
mergeInputs(index, a, b) -> { shared: ChatNode[], segA: ChatNode[], segB: ChatNode[] }
buildMergeRequest(inputs, instruction?) -> Message[]
```

**Validation** (the server enforces it, and the client mirrors it to dim invalid choices):
- `a !== b`, and both are in the same tree.
- Both have `status === 'done'`. You cannot merge root, a streaming node or an errored node.
- Neither is an ancestor of the other (`ancestorIds`). Otherwise one already contains the other, so there is nothing to merge.

**Inputs:** `shared` is the common prefix of the two context chains, and `segA` / `segB` are the rest of each chain. Each segment contains what the model would see from that node: if a branch itself passes through an earlier merge, that merge's summary appears in the segment.

**Summarization call.** This is a one-off request; it is not added to the chat context:
- System: "You merge two divergent branches of one conversation into a single summary that the conversation can continue from."
- One user message, containing:
  1. `<shared_context>` (background only, do not re-summarize; it stays in context anyway)
  2. `<branch_a>`
  3. `<branch_b>`
  4. Instructions: for each branch, give the key facts, decisions, conclusions and open questions. Point out any contradictions between the branches. End with a combined summary, written as the assistant's own summary so the conversation reads naturally. Then the optional `mergeInstruction`.
- The tags keep branch content from being confused with instructions.

**The stored merge node:**
- `parentIds = [a, b]` and `kind = 'merge'`.
- `userMessage` is a short, human-readable request built from the template, for example: `Merge our two branches: "<A's question>" and "<B's question>". <instruction>`. This is the user turn that later context shows the model.
- `assistantMessage` is the streamed summary.
- After it finishes, select it so the next message continues from the merged state.

**Size limit (MVP):** if the combined transcript is over a character budget (about 400k characters, configurable), shorten the oldest messages in each segment and mark where text was cut.

### 5c. Delete

`descendantIds(index, id)`: a breadth-first walk over the `children` map. It collects everything reachable *downward*. Any merge node with a deleted parent is reachable, so it is deleted, and so is everything below it.

Example: you delete `A`, and `M` merges `A` and `B`. Then `M` and all of `M`'s descendants are deleted. `B` and its own other children stay.

- The server runs it in one transaction: compute the set from the tree's nodes, then `DELETE FROM nodes WHERE id IN (...)` (the link rows cascade).
- Root cannot be deleted; delete the whole tree instead.
- Any generation running on a deleted node is aborted, using a server-side `Map<NodeId, AbortController>`. Late writes to a missing node are ignored.
- The client shows a confirmation dialog with the count ("Delete 7 nodes?"). Before confirming, the nodes about to be deleted are highlighted in red in the graph.

## 6. Server API

```
GET    /api/trees                       list (the owner's trees only)
POST   /api/trees                       create tree + root node -> { tree, root }
GET    /api/trees/:id                   { tree, nodes[] }  (whole tree with parentIds; fine for MVP sizes)
PATCH  /api/trees/:id                   rename
DELETE /api/trees/:id
POST   /api/nodes        { parentId, userMessage }            -> SSE stream
POST   /api/merges       { parentIds: [a, b], instruction? }  -> SSE stream
POST   /api/nodes/:id/retry             re-run an errored chat or merge node -> SSE stream
DELETE /api/nodes/:id                   deletes the node and all its descendants -> { deletedIds }
```

The flow is shared by both streaming endpoints, through a single `runGeneration(nodeId, messages)`:
1. Validate (parent exists and is `root`/`done`, or `validateMerge`), and check ownership.
2. Insert the node and its `node_parents` rows with `status='streaming'`, in one transaction.
3. Send an SSE `node` event, so the client places the node right away.
4. Load the tree's nodes, build the index, then call `buildContext(contextChain(...))` for a chat node or `buildMergeRequest(mergeInputs(...))` for a merge node, and call `streamChat`.
5. Forward each token as an SSE `token` event. Flush text to the DB every ~500ms and at the end.
6. Finish with `status='done'` and a `done` event. On failure, set `status='error'` and send an `error` event.
7. If the client disconnects, keep the generation going and save it. On server startup, mark any leftover `streaming` rows as `error` ("interrupted").

Because the server builds the context from the DB, the client never sends history. Retry checks `kind` to decide which builder to call.

## 7. Client

**Store (Zustand):**
```ts
{
  trees: Tree[]; currentTreeId?: string;
  nodes: Record<NodeId, ChatNode>;
  selectedId: NodeId;                        // the "cursor": the state you're in
  mergeDraft?: { a: NodeId; b?: NodeId };    // while picking a merge target
  // derived via selectors: index, contextChain(selectedId), children
  actions: loadTrees, openTree, createTree, deleteTree, renameTree,
           select(id), send(text), retry(id), deleteNode(id),
           startMerge(), pickMergeTarget(id), cancelMerge(), confirmMerge(instruction?)
}
```
- `send(text)` creates a child of `selectedId`. When the `node` event arrives, insert the node and **move the selection to it**. Tokens are appended to that node, and batched per animation frame if rendering lags.
- Several generations can run at once on different branches; each one writes only to its own node.
- `deleteNode` removes the returned `deletedIds`. If the selected node was among them, the selection moves to the deleted node's first parent.

**Layout (two panes, resizable):**
- **Left: Graph** (React Flow; pan, zoom and click only).
  - Positions come from the data on every change, using **dagre** (`@dagrejs/dagre`, layered top-to-bottom). Unlike a tree layout, dagre handles nodes with two parents and places a merge node below both of them. Positions are never stored.
  - Node card: a truncated user message (or "Start" for root), the first line of the reply, and a status dot. Merge nodes get a distinct color and a merge icon. Both incoming edges are solid, because both are real parents.
  - Highlighting: the selected node is strong, and nodes in its `contextChain` are tinted. For a merge in the chain, the two summarized branch segments get a lighter tint, so you can see what was folded into the summary.
  - Click a node to `select(id)`. Fit the view on load, and center a newly created node.
- **Right: Chat** shows `contextChain(selectedId)` as a normal transcript (`react-markdown`).
  - A merge turn renders as a "Merged branches" card, with the summary and links that jump to each parent.
  - Each message shows an "N branches" indicator when its node has more than one child.
  - Clicking any message selects that node, so the next send creates a branch from there.
  - A banner over the input when the selected node already has children: "Sending will create a new branch from here."
  - Input is disabled while the node is streaming or in error; the error state shows Retry.
- **Merge flow:** select a node, then click "Merge with…". The graph enters picking mode and dims invalid targets. Click the second node to open a dialog with both branch previews (the messages since the split), an optional instruction field, and Merge / Cancel. Esc cancels.
- **Top bar:** tree switcher, "New tree" button, rename.

## 8. Build order (milestones)

1. **Scaffold:** npm workspaces (client / server / shared), Vite React TS, TS server, `.env`, and a Vite dev proxy for `/api`.
2. **Core graph lib + tests** (Vitest): `buildIndex`, `ancestorIds`, `contextChain`, `buildContext`, `descendantIds`, `validateMerge`, `mergeInputs`, `buildMergeRequest`, with every edge case in section 5. *Finish this first; it is the part that must be solid.*
3. **Server:** schema, repository layer, tree CRUD, `runGeneration` + SSE, `POST /api/nodes`, and descendant delete. Test it with curl.
4. **Chat-only client:** store, linear chat for the selected node, and send with streaming. At this point it works like ChatGPT.
5. **Graph view:** React Flow + dagre, click to select, highlighting. Branching works end to end.
6. **Merge:** `POST /api/merges`, picking mode, the dialog, merge node rendering.
7. **Robustness:** errors and retry, recovery from interrupted streams, delete with preview and confirmation, tree list and rename, auto-scroll and centering.

Done when:
- You can branch 3+ levels deep, reload the page, click any node, and continue from it. Each branch sees only its own history: test this with "what's my name?" in different branches.
- Tell branch A "my name is Sam" and branch B "my favorite color is green", then merge them. The merge node sits below both. A question under it recalls both facts, and each original branch still recalls only its own fact.
- Deleting A removes A, the merge node and everything under the merge node. B is untouched.

## 9. Key libraries

`@xyflow/react`, `@dagrejs/dagre`, `zustand`, `react-markdown` + `remark-gfm`, `hono` (or `express`), `better-sqlite3`, `@anthropic-ai/sdk` (behind the adapter), `uuid`, `vitest`, `tailwindcss`.

## 10. Decisions

- **LLM provider:** OpenRouter (switched from Anthropic), behind the `streamChat` adapter in `server/src/llm.ts`. Default model `deepseek/deepseek-v4-flash` for both chat and merges; separate env vars allow changing either.
- **Users:** local single-user for now. It may later be deployed for multiple users (section 11).
- **Merge structure:** the merge node has both merged nodes as real parents (a DAG). The context model in 5a makes that well-defined.
- **Delete:** removes the node and everything reachable below it, including merges that have it as either parent.

## 11. Ready for deployment later (cheap things to do now)

- **Owner scoping from day one.** `trees.owner_id` exists already. Every route gets its user from one middleware, `getUserId(req)`, which returns `'local'` for now. Every query is filtered by owner; nodes are reached through their tree. Adding auth later means changing that one function.
- **Repository layer.** All SQL lives in `server/db/*.ts`, so routes never contain SQL. Moving to Postgres later is a change in one place.
- **Ownership checks:** for every node id that comes from the client, the server confirms it belongs to a tree the user owns, and for merges, that both are in the same tree.
- **Secrets and config** come only from `.env` (`ANTHROPIC_API_KEY`, `CHAT_MODEL`, `MERGE_MODEL`, `DB_PATH`, `PORT`). `.env` goes in `.gitignore`.
- **Not done now:** auth itself, rate limiting, per-user quotas, CORS hardening.
