import { create } from 'zustand';
import { buildIndex, getChildren, type ChatNode, type GraphIndex, type NodeId, type Tree } from '@llmb/shared';
import { api, streamPost, type StreamHandlers } from './api';

const DEFAULT_TITLE = 'New tree';

interface State {
  trees: Tree[];
  currentTreeId: string | null;
  nodes: Record<NodeId, ChatNode>;
  selectedId: NodeId | null;
  error: string | null;
  /** Merge in progress: `a` chosen, waiting for `b` (picking mode), then the confirm dialog. */
  mergeDraft: { a: NodeId; b?: NodeId } | null;
  /** Node whose deletion is being confirmed (graph previews what will go). */
  deleteTarget: NodeId | null;
  /** Number of open SSE requests from this tab. */
  streamsInFlight: number;

  init: () => Promise<void>;
  openTree: (id: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  createTree: () => Promise<void>;
  renameTree: (id: string, title: string) => Promise<void>;
  deleteTree: (id: string) => Promise<void>;
  select: (id: NodeId) => void;
  send: (text: string) => Promise<void>;
  retry: (id: NodeId) => Promise<void>;
  startMerge: (a: NodeId) => void;
  pickMergeTarget: (b: NodeId) => void;
  cancelMerge: () => void;
  confirmMerge: (instruction: string) => Promise<void>;
  askDelete: (id: NodeId) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  setError: (e: string | null) => void;
}

export const useStore = create<State>((set, get) => {
  // Token batching: buffer tokens and apply them once per animation frame.
  const pending = new Map<NodeId, string>();
  let frame: number | null = null;
  const flushTokens = () => {
    frame = null;
    if (!pending.size) return;
    const updates = new Map(pending);
    pending.clear();
    set((s) => {
      const nodes = { ...s.nodes };
      for (const [id, text] of updates) {
        const n = nodes[id];
        if (n) nodes[id] = { ...n, assistantMessage: n.assistantMessage + text };
      }
      return { nodes };
    });
  };

  const patchNode = (id: NodeId, patch: Partial<ChatNode>) =>
    set((s) => (s.nodes[id] ? { nodes: { ...s.nodes, [id]: { ...s.nodes[id], ...patch } } } : s));

  const fail = (err: unknown) => set({ error: err instanceof Error ? err.message : String(err) });

  /**
   * Handlers shared by send / retry / merge streams. The first `node` event is the
   * stream's own node; later ones are merges the assistant made with its tools.
   */
  const handlers = (selectOnCreate: boolean): StreamHandlers => {
    let first = true;
    return {
      node: (node) => {
        const own = first;
        first = false;
        if (node.treeId !== get().currentTreeId) return;
        set((s) => ({
          nodes: { ...s.nodes, [node.id]: node },
          ...(selectOnCreate && own && { selectedId: node.id }),
        }));
      },
      token: (id, text) => {
        pending.set(id, (pending.get(id) ?? '') + text);
        frame ??= requestAnimationFrame(flushTokens);
      },
      done: (id, text) => {
        pending.delete(id);
        patchNode(id, { assistantMessage: text, status: 'done', error: undefined });
      },
      error: (id, message) => {
        flushTokens();
        patchNode(id, { status: 'error', error: message });
      },
      step: (id, step) => {
        const n = get().nodes[id];
        if (n) patchNode(id, { actions: [...(n.actions ?? []), step] });
      },
      deleted: (ids) => removeNodes(ids),
    };
  };

  /** Drop nodes from the view; if the selection went with them, select the nearest surviving ancestor. */
  const removeNodes = (ids: NodeId[]) => {
    const gone = new Set(ids);
    set((s) => {
      let sel = s.selectedId;
      while (sel && gone.has(sel)) sel = s.nodes[sel]?.parentIds[0] ?? null;
      return {
        nodes: Object.fromEntries(Object.entries(s.nodes).filter(([k]) => !gone.has(k))),
        selectedId: sel,
        deleteTarget: s.deleteTarget && gone.has(s.deleteTarget) ? null : s.deleteTarget,
        mergeDraft: s.mergeDraft && (gone.has(s.mergeDraft.a) || (s.mergeDraft.b && gone.has(s.mergeDraft.b))) ? null : s.mergeDraft,
      };
    });
  };

  /** Run one SSE request, tracking how many are open (the resync poller relies on it). */
  const stream = async (url: string, body: unknown, selectOnCreate: boolean) => {
    set((s) => ({ streamsInFlight: s.streamsInFlight + 1 }));
    try {
      await streamPost(url, body, handlers(selectOnCreate));
    } catch (e) {
      fail(e);
    } finally {
      set((s) => ({ streamsInFlight: s.streamsInFlight - 1 }));
    }
  };

  const loadNodes = async (treeId: string) => {
    const { tree, nodes } = await api.getTree(treeId);
    set((s) => ({ trees: s.trees.map((t) => (t.id === tree.id ? tree : t)) }));
    return nodes;
  };

  return {
    trees: [],
    currentTreeId: null,
    nodes: {},
    selectedId: null,
    error: null,
    mergeDraft: null,
    deleteTarget: null,
    streamsInFlight: 0,

    init: async () => {
      try {
        const trees = await api.listTrees();
        set({ trees });
        if (trees[0]) await get().openTree(trees[0].id);
        else await get().createTree();
      } catch (e) {
        fail(e);
      }
    },

    openTree: async (id) => {
      try {
        const nodes = await loadNodes(id);
        // Resume where you left off: the most recently created node.
        const latest = nodes.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        set({
          currentTreeId: id,
          nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
          selectedId: latest.id,
          mergeDraft: null,
          deleteTarget: null,
        });
      } catch (e) {
        fail(e);
      }
    },

    /** Re-read the current tree from the server (used to pick up generations this tab isn't streaming). */
    refreshTree: async () => {
      const id = get().currentTreeId;
      if (!id) return;
      try {
        const nodes = await loadNodes(id);
        if (get().currentTreeId !== id) return;
        const map = Object.fromEntries(nodes.map((n) => [n.id, n]));
        set((s) => ({ nodes: map, selectedId: s.selectedId && map[s.selectedId] ? s.selectedId : nodes[0]?.id ?? null }));
      } catch {
        /* transient; next poll retries */
      }
    },

    createTree: async () => {
      try {
        const { tree } = await api.createTree(DEFAULT_TITLE);
        set((s) => ({ trees: [tree, ...s.trees] }));
        await get().openTree(tree.id);
      } catch (e) {
        fail(e);
      }
    },

    renameTree: async (id, title) => {
      try {
        const tree = await api.renameTree(id, title);
        set((s) => ({ trees: s.trees.map((t) => (t.id === id ? tree : t)) }));
      } catch (e) {
        fail(e);
      }
    },

    deleteTree: async (id) => {
      try {
        await api.deleteTree(id);
        const trees = get().trees.filter((t) => t.id !== id);
        set({ trees });
        if (get().currentTreeId === id) {
          set({ currentTreeId: null, nodes: {}, selectedId: null });
          if (trees[0]) await get().openTree(trees[0].id);
          else await get().createTree();
        }
      } catch (e) {
        fail(e);
      }
    },

    select: (id) => set({ selectedId: id }),

    send: async (text) => {
      const parentId = get().selectedId;
      const treeId = get().currentTreeId;
      if (!parentId || !treeId || !text.trim()) return;
      const tree = get().trees.find((t) => t.id === treeId);
      await stream('/api/nodes', { parentId, userMessage: text }, true);
      // The server names untitled trees after their first message.
      if (tree?.title === DEFAULT_TITLE) void loadNodes(treeId).catch(() => {});
    },

    retry: (id) => stream(`/api/nodes/${id}/retry`, {}, false),

    startMerge: (a) => set({ mergeDraft: { a }, deleteTarget: null }),
    pickMergeTarget: (b) => set((s) => (s.mergeDraft ? { mergeDraft: { ...s.mergeDraft, b } } : s)),
    cancelMerge: () => set({ mergeDraft: null }),
    confirmMerge: async (instruction) => {
      const draft = get().mergeDraft;
      if (!draft?.b) return;
      set({ mergeDraft: null });
      await stream('/api/merges', { parentIds: [draft.a, draft.b], instruction }, true);
    },

    askDelete: (id) => set({ deleteTarget: id, mergeDraft: null }),
    cancelDelete: () => set({ deleteTarget: null }),
    confirmDelete: async () => {
      const id = get().deleteTarget;
      const node = id ? get().nodes[id] : undefined;
      set({ deleteTarget: null });
      if (!id || !node) return;
      try {
        const { deletedIds } = await api.deleteNode(id);
        removeNodes(deletedIds);
      } catch (e) {
        fail(e);
      }
    },

    setError: (error) => set({ error }),
  };
});

// ---------------------------------------------------------------- derived

let cachedNodes: Record<NodeId, ChatNode> | null = null;
let cachedIndex: GraphIndex | null = null;

/** Graph index for the current nodes, rebuilt only when the nodes object changes. */
export function useIndex(): GraphIndex {
  const nodes = useStore((s) => s.nodes);
  if (nodes !== cachedNodes) {
    cachedNodes = nodes;
    cachedIndex = buildIndex(Object.values(nodes));
  }
  return cachedIndex!;
}

/** Follow the most recent child down to a leaf: "continue where this branch left off". */
export function latestLeaf(index: GraphIndex, id: NodeId): NodeId {
  let cur = id;
  for (;;) {
    const kids = getChildren(index, cur);
    const last = kids[kids.length - 1];
    if (!last) return cur;
    cur = last;
  }
}

/** Short label for a node, for buttons and dialogs. */
export function nodeLabel(n: ChatNode | undefined): string {
  if (!n) return '';
  if (n.kind === 'root') return 'Start';
  if (n.kind === 'merge') return 'Merged branches';
  const line = n.userMessage.split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
