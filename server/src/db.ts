import Database from 'better-sqlite3';
import type { ChatNode, NodeId, NodeKind, NodeStatus, ToolStep, Tree } from '@llmb/shared';
import { config } from './config';

/**
 * Repository layer: all SQL lives here. Every tree access is scoped by owner so
 * that adding auth later only means changing getUserId().
 */

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  root_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL DEFAULT '',
  merge_instruction TEXT,
  status TEXT NOT NULL,
  error TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_parents (
  child_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (child_id, parent_id)
);
CREATE INDEX IF NOT EXISTS trees_owner ON trees(owner_id);
CREATE INDEX IF NOT EXISTS nodes_tree ON nodes(tree_id);
CREATE INDEX IF NOT EXISTS node_parents_parent ON node_parents(parent_id);
`);

// Migrations for databases created before a column existed.
const nodeColumns = new Set((db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map((c) => c.name));
if (!nodeColumns.has('actions')) db.exec('ALTER TABLE nodes ADD COLUMN actions TEXT');

interface TreeRow {
  id: string; owner_id: string; title: string; root_id: string; created_at: number; updated_at: number;
}
interface NodeRow {
  id: string; tree_id: string; kind: NodeKind; user_message: string; assistant_message: string;
  merge_instruction: string | null; status: NodeStatus; error: string | null; model: string | null;
  actions: string | null; created_at: number;
}

const toTree = (r: TreeRow): Tree => ({
  id: r.id, ownerId: r.owner_id, title: r.title, rootId: r.root_id,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const toNode = (r: NodeRow, parentIds: NodeId[]): ChatNode => ({
  id: r.id,
  treeId: r.tree_id,
  parentIds,
  kind: r.kind,
  userMessage: r.user_message,
  assistantMessage: r.assistant_message,
  ...(r.merge_instruction != null && { mergeInstruction: r.merge_instruction }),
  status: r.status,
  ...(r.error != null && { error: r.error }),
  ...(r.model != null && { model: r.model }),
  ...(r.actions != null && { actions: JSON.parse(r.actions) as ToolStep[] }),
  createdAt: r.created_at,
});

// ---------------------------------------------------------------- trees

export function listTrees(ownerId: string): Tree[] {
  const rows = db
    .prepare('SELECT * FROM trees WHERE owner_id = ? ORDER BY updated_at DESC')
    .all(ownerId) as TreeRow[];
  return rows.map(toTree);
}

export function getTree(ownerId: string, treeId: string): Tree | undefined {
  const row = db
    .prepare('SELECT * FROM trees WHERE id = ? AND owner_id = ?')
    .get(treeId, ownerId) as TreeRow | undefined;
  return row && toTree(row);
}

export const createTree = db.transaction((ownerId: string, title: string) => {
  const now = Date.now();
  const treeId = crypto.randomUUID();
  const rootId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO trees (id, owner_id, title, root_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(treeId, ownerId, title, rootId, now, now);
  db.prepare(
    `INSERT INTO nodes (id, tree_id, kind, user_message, status, created_at)
     VALUES (?, ?, 'root', '', 'root', ?)`,
  ).run(rootId, treeId, now);
  return { tree: getTree(ownerId, treeId)!, root: getNodesOfTree(treeId)[0]! };
});

export function renameTree(ownerId: string, treeId: string, title: string): boolean {
  return db
    .prepare('UPDATE trees SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
    .run(title, Date.now(), treeId, ownerId).changes > 0;
}

export function deleteTree(ownerId: string, treeId: string): boolean {
  return db.prepare('DELETE FROM trees WHERE id = ? AND owner_id = ?').run(treeId, ownerId).changes > 0;
}

function touchTree(treeId: string) {
  db.prepare('UPDATE trees SET updated_at = ? WHERE id = ?').run(Date.now(), treeId);
}

// ---------------------------------------------------------------- nodes

/** All nodes of a tree, with ordered parentIds. Caller must have checked ownership. */
export function getNodesOfTree(treeId: string): ChatNode[] {
  const rows = db
    .prepare('SELECT * FROM nodes WHERE tree_id = ? ORDER BY created_at, id')
    .all(treeId) as NodeRow[];
  const links = db
    .prepare(
      `SELECT np.child_id, np.parent_id FROM node_parents np
       JOIN nodes n ON n.id = np.child_id
       WHERE n.tree_id = ? ORDER BY np.child_id, np.position`,
    )
    .all(treeId) as { child_id: string; parent_id: string }[];
  const parents = new Map<string, string[]>();
  for (const l of links) {
    const list = parents.get(l.child_id) ?? [];
    list.push(l.parent_id);
    parents.set(l.child_id, list);
  }
  return rows.map((r) => toNode(r, parents.get(r.id) ?? []));
}

/** Resolve a node's tree, checking the owner. Returns undefined if not found / not owned. */
export function getOwnedTreeIdOfNode(ownerId: string, nodeId: NodeId): string | undefined {
  const row = db
    .prepare(
      `SELECT n.tree_id FROM nodes n JOIN trees t ON t.id = n.tree_id
       WHERE n.id = ? AND t.owner_id = ?`,
    )
    .get(nodeId, ownerId) as { tree_id: string } | undefined;
  return row?.tree_id;
}

export interface NewNode {
  treeId: string;
  parentIds: NodeId[];
  kind: 'chat' | 'merge';
  userMessage: string;
  mergeInstruction?: string;
  model: string;
}

export const insertNode = db.transaction((n: NewNode): ChatNode => {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO nodes (id, tree_id, kind, user_message, merge_instruction, status, model, created_at)
     VALUES (?, ?, ?, ?, ?, 'streaming', ?, ?)`,
  ).run(id, n.treeId, n.kind, n.userMessage, n.mergeInstruction ?? null, n.model, now);
  const link = db.prepare('INSERT INTO node_parents (child_id, parent_id, position) VALUES (?, ?, ?)');
  n.parentIds.forEach((p, i) => link.run(id, p, i));
  touchTree(n.treeId);
  return {
    id, treeId: n.treeId, parentIds: [...n.parentIds], kind: n.kind,
    userMessage: n.userMessage, assistantMessage: '',
    ...(n.mergeInstruction && { mergeInstruction: n.mergeInstruction }),
    status: 'streaming', model: n.model, createdAt: now,
  };
});

export function setAssistantText(id: NodeId, text: string) {
  db.prepare(`UPDATE nodes SET assistant_message = ? WHERE id = ? AND status = 'streaming'`).run(text, id);
}

export function setActions(id: NodeId, actions: ToolStep[]) {
  db.prepare('UPDATE nodes SET actions = ? WHERE id = ?').run(actions.length ? JSON.stringify(actions) : null, id);
}

export function finishNode(id: NodeId, text: string) {
  db.prepare(
    `UPDATE nodes SET assistant_message = ?, status = 'done', error = NULL WHERE id = ?`,
  ).run(text, id);
}

export function failNode(id: NodeId, text: string, error: string) {
  db.prepare(`UPDATE nodes SET assistant_message = ?, status = 'error', error = ? WHERE id = ?`).run(
    text, error, id,
  );
}

export function resetForRetry(id: NodeId, model: string) {
  db.prepare(
    `UPDATE nodes SET assistant_message = '', status = 'streaming', error = NULL, actions = NULL, model = ? WHERE id = ?`,
  ).run(model, id);
}

export const deleteNodes = db.transaction((treeId: string, ids: NodeId[]) => {
  const del = db.prepare('DELETE FROM nodes WHERE id = ? AND tree_id = ?');
  for (const id of ids) del.run(id, treeId);
  touchTree(treeId);
});

/** On startup: any generation that was running when the server stopped is lost. */
export function markInterrupted() {
  return db
    .prepare(`UPDATE nodes SET status = 'error', error = 'Interrupted (server restarted)' WHERE status = 'streaming'`)
    .run().changes;
}
