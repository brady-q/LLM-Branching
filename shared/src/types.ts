export type NodeId = string;

export type NodeKind = 'root' | 'chat' | 'merge';
export type NodeStatus = 'root' | 'streaming' | 'done' | 'error';

/** One tool action the assistant took while writing a reply (e.g. a merge or delete). */
export interface ToolStep {
  text: string;
  ok: boolean;
}

export interface ChatNode {
  id: NodeId;
  treeId: string;
  /** root: [], chat: [parent], merge: [a, b] (ordered) */
  parentIds: NodeId[];
  kind: NodeKind;
  userMessage: string;
  assistantMessage: string;
  mergeInstruction?: string;
  status: NodeStatus;
  error?: string;
  model?: string;
  /** Tool actions taken while producing this reply, in order. */
  actions?: ToolStep[];
  createdAt: number;
}

export interface Tree {
  id: string;
  ownerId: string;
  title: string;
  rootId: NodeId;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
