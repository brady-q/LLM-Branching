import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChangeset,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  contextChain,
  descendantIds,
  mergeInputs,
  validateMerge,
  type ChatNode,
  type GraphIndex,
  type NodeId,
} from '@llmb/shared';
import { nodeLabel, useIndex, useStore } from '../store';

const NODE_W = 220;
const NODE_H = 76;

type Highlight = 'selected' | 'path' | 'summarized' | 'none';
type CardData = { node: ChatNode; highlight: Highlight; overlay: Overlay };
/** Transient UI states drawn on top of the highlight. */
type Overlay = 'deleting' | 'mergeSource' | 'mergeTarget' | 'dimmed' | null;
type CardNode = Node<CardData, 'card'>;

export function GraphPanel() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  );
}

function Graph() {
  const index = useIndex();
  const selectedId = useStore((s) => s.selectedId);
  const currentTreeId = useStore((s) => s.currentTreeId);
  const select = useStore((s) => s.select);
  const mergeDraft = useStore((s) => s.mergeDraft);
  const deleteTarget = useStore((s) => s.deleteTarget);
  const flow = useReactFlow();
  const picking = mergeDraft != null && !mergeDraft.b;

  const deletingIds = useMemo(
    () => new Set(deleteTarget && index.byId.has(deleteTarget) ? [deleteTarget, ...descendantIds(index, deleteTarget)] : []),
    [index, deleteTarget],
  );
  const mergeValid = useMemo(() => {
    const ok = new Set<NodeId>();
    if (!picking) return ok;
    for (const id of index.byId.keys()) if (validateMerge(index, mergeDraft.a, id).ok) ok.add(id);
    return ok;
  }, [index, picking, mergeDraft]);

  const overlayOf = (id: NodeId): Overlay => {
    if (deletingIds.has(id)) return 'deleting';
    if (mergeDraft?.a === id) return 'mergeSource';
    if (mergeDraft?.b === id) return 'mergeTarget';
    if (picking && !mergeValid.has(id)) return 'dimmed';
    return null;
  };

  const onNodeClick = (id: NodeId) => {
    if (picking) {
      if (mergeValid.has(id)) useStore.getState().pickMergeTarget(id);
      return;
    }
    select(id);
  };

  const layout = useLayout(index);
  const [overrides, setOverrides] = useManualPositions(currentTreeId);
  const positionOf = useCallback(
    (id: NodeId) => overrides[id] ?? layout.get(id),
    [overrides, layout],
  );
  const { chainIds, summarizedIds } = useHighlights(index, selectedId);

  // Built without positions so dragging doesn't re-render every card.
  const baseNodes = useMemo(
    () =>
      [...index.byId.values()].map((n) => ({
        id: n.id,
        type: 'card' as const,
        data: {
          node: n,
          highlight:
            n.id === selectedId ? 'selected' : chainIds.has(n.id) ? 'path' : summarizedIds.has(n.id) ? 'summarized' : 'none',
          overlay: overlayOf(n.id),
        } satisfies CardData,
        connectable: false,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, selectedId, chainIds, summarizedIds, deletingIds, mergeValid, mergeDraft],
  );
  // React Flow owns the live node objects (keeps their measured size, so nodes
  // aren't hidden and re-measured on every update, which caused flicker).
  const [nodes, setNodes] = useState<CardNode[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return baseNodes.map((n) => {
        const old = prevById.get(n.id);
        // Don't yank a node out from under the cursor mid-drag (e.g. while a reply streams).
        const position = old?.dragging ? old.position : (positionOf(n.id) ?? { x: 0, y: 0 });
        return old ? { ...old, ...n, position } : { ...n, position };
      });
    });
  }, [baseNodes, positionOf]);

  const onNodesChange = useCallback(
    (changes: NodeChangeset<CardNode>) => {
      setNodes((ns) => changes.applyTo(ns));
    },
    [],
  );
  // Persist only when a drag finishes, not on every frame.
  const onNodeDragStop = useCallback(
    (_: unknown, _node: CardNode, dragged: CardNode[]) => {
      const dropped: Record<NodeId, XY> = {};
      for (const n of dragged) dropped[n.id] = { x: n.position.x, y: n.position.y };
      setOverrides((o) => ({ ...o, ...dropped }));
    },
    [setOverrides],
  );

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const n of index.byId.values()) {
      for (const p of n.parentIds) {
        const onPath = chainIds.has(n.id) && chainIds.has(p);
        const summarized = !onPath && (summarizedIds.has(p) || chainIds.has(p)) && (summarizedIds.has(n.id) || chainIds.has(n.id));
        const color = onPath ? '#3d7a5c' : summarized ? '#5b5bd6' : '#c3ccc5';
        out.push({
          id: `${p}->${n.id}`,
          source: p,
          target: n.id,
          type: 'smoothstep',
          style: { stroke: color, strokeWidth: onPath ? 2.5 : 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          selectable: false,
          zIndex: onPath ? 1 : 0,
        });
      }
    }
    return out;
  }, [index, chainIds, summarizedIds]);

  // Fit the whole graph when a tree is opened.
  useEffect(() => {
    if (!currentTreeId) return;
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [currentTreeId, flow]);

  // Center on a newly created node.
  const prevCount = useRef(index.byId.size);
  useEffect(() => {
    const grew = index.byId.size > prevCount.current;
    prevCount.current = index.byId.size;
    const pos = selectedId ? positionOf(selectedId) : undefined;
    if (grew && pos) {
      void flow.setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom: flow.getZoom(), duration: 300 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, selectedId, flow]);

  return (
    <div className="relative h-full">
    <Toolbar picking={picking} />
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onNodeClick(n.id)}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodesDraggable
      nodesConnectable={false}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cfd6d0" bgColor="#f8f9f7" />
      <Controls showInteractive={false}>
        {Object.keys(overrides).length > 0 && (
          <ControlButton title="Reset layout (undo manual node moves)" onClick={() => setOverrides({})}>
            ↺
          </ControlButton>
        )}
      </Controls>
    </ReactFlow>
    </div>
  );
}

/** Actions for the selected node, or the merge-picking banner. */
function Toolbar({ picking }: { picking: boolean }) {
  const index = useIndex();
  const selectedId = useStore((s) => s.selectedId);
  const mergeDraft = useStore((s) => s.mergeDraft);
  const { startMerge, cancelMerge, askDelete } = useStore.getState();
  const selected = selectedId ? index.byId.get(selectedId) : undefined;

  if (picking && mergeDraft) {
    return (
      <div className="absolute top-3 right-3 left-3 z-10 flex items-center gap-3 rounded-full bg-graft py-1.5 pr-1.5 pl-4 text-sm text-white">
        <span className="truncate">
          Click the node to merge with <b>"{nodeLabel(index.byId.get(mergeDraft.a))}"</b>. Faded nodes can't be merged.
        </span>
        <button className="ml-auto shrink-0 rounded-full bg-white/20 px-3 py-1 hover:bg-white/30" onClick={cancelMerge}>
          Cancel (Esc)
        </button>
      </div>
    );
  }
  if (!selected || selected.kind === 'root') return null;
  return (
    <div className="absolute left-3 top-3 z-10 flex gap-2">
      <button
        className="btn hover:!border-graft/50 hover:!bg-graft-soft hover:!text-graft"
        disabled={selected.status !== 'done'}
        title={selected.status !== 'done' ? 'Only nodes with a finished reply can be merged' : 'Merge this branch with another'}
        onClick={() => startMerge(selected.id)}
      >
        Merge with…
      </button>
      <button className="btn hover:!border-rust/40 hover:!bg-rust-soft hover:!text-rust" onClick={() => askDelete(selected.id)}>
        Delete
      </button>
    </div>
  );
}

type XY = { x: number; y: number };

/** Positions of nodes the user dragged, per tree, remembered in localStorage. */
function useManualPositions(treeId: string | null) {
  const key = treeId ? `llmb:positions:${treeId}` : null;
  const [state, setState] = useState<{ key: string | null; pos: Record<NodeId, XY> }>(() => ({ key, pos: load(key) }));
  // Switching trees: load that tree's saved positions.
  const pos = state.key === key ? state.pos : load(key);
  if (state.key !== key) setState({ key, pos });

  const set = useCallback(
    (fn: Record<NodeId, XY> | ((p: Record<NodeId, XY>) => Record<NodeId, XY>)) =>
      setState((s) => {
        const next = typeof fn === 'function' ? fn(s.pos) : fn;
        if (s.key) {
          try {
            if (Object.keys(next).length) localStorage.setItem(s.key, JSON.stringify(next));
            else localStorage.removeItem(s.key);
          } catch {
            /* storage unavailable: positions just won't persist */
          }
        }
        return { ...s, pos: next };
      }),
    [],
  );
  return [pos, set] as const;
}

function load(key: string | null): Record<NodeId, XY> {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

/** dagre layout, recomputed only when the graph's structure changes (not on every streamed token). */
function useLayout(index: GraphIndex) {
  const signature = [...index.byId.values()].map((n) => `${n.id}<${n.parentIds.join(',')}`).join(';');
  return useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 50 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of index.byId.values()) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    for (const n of index.byId.values()) for (const p of n.parentIds) g.setEdge(p, n.id);
    dagre.layout(g);
    const pos = new Map<NodeId, { x: number; y: number }>();
    for (const id of g.nodes()) {
      const { x, y } = g.node(id);
      pos.set(id, { x: x - NODE_W / 2, y: y - NODE_H / 2 });
    }
    return pos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

/** Nodes in the selected node's context, and nodes whose content reached it only through a merge summary. */
function useHighlights(index: GraphIndex, selectedId: NodeId | null) {
  return useMemo(() => {
    const chainIds = new Set<NodeId>();
    const summarizedIds = new Set<NodeId>();
    if (!selectedId || !index.byId.has(selectedId)) return { chainIds, summarizedIds };
    const chain = contextChain(index, selectedId);
    for (const n of chain) chainIds.add(n.id);
    // Walk merges (including nested ones inside summarized segments).
    const merges = chain.filter((n) => n.kind === 'merge');
    while (merges.length) {
      const m = merges.pop()!;
      const [a, b] = m.parentIds;
      if (!a || !b) continue;
      for (const seg of mergeInputs(index, a, b).segments) {
        for (const n of seg) {
          if (chainIds.has(n.id) || summarizedIds.has(n.id)) continue;
          summarizedIds.add(n.id);
          if (n.kind === 'merge') merges.push(n);
        }
      }
    }
    return { chainIds, summarizedIds };
  }, [index, selectedId]);
}

/** Card surface per highlight. The left stem carries the node's kind/state color. */
const STYLES: Record<Highlight, string> = {
  selected: 'border-moss bg-surface ring-4 ring-moss/20',
  path: 'border-moss/40 bg-moss-soft',
  summarized: 'border-graft/30 bg-graft-soft',
  none: 'border-line bg-surface',
};

const OVERLAYS: Record<Exclude<Overlay, null>, string> = {
  deleting: '!border-rust !bg-rust-soft ring-4 ring-rust/20',
  mergeSource: '!border-graft ring-4 ring-graft/25',
  mergeTarget: '!border-graft ring-4 ring-graft/25',
  dimmed: 'opacity-35 !cursor-not-allowed',
};

const Card = memo(function Card({ data }: NodeProps<CardNode>) {
  const { node, highlight, overlay } = data;
  const dot =
    node.status === 'streaming' ? 'bg-moss animate-pulse' : node.status === 'error' ? 'bg-rust' : 'hidden';
  const stem =
    overlay === 'deleting'
      ? 'bg-rust'
      : node.kind === 'merge'
        ? 'bg-graft'
        : highlight === 'selected' || highlight === 'path'
          ? 'bg-moss'
          : highlight === 'summarized'
            ? 'bg-graft/60'
            : 'bg-line';

  let title: string;
  let sub: string;
  if (node.kind === 'root') {
    title = 'Start';
    sub = 'Beginning of the conversation';
  } else if (node.kind === 'merge') {
    title = 'Merged branches';
    sub = firstLine(node.assistantMessage) || (node.status === 'streaming' ? 'Summarizing…' : '');
  } else {
    title = firstLine(node.userMessage);
    sub = node.status === 'error' ? (node.error ?? 'Failed') : firstLine(node.assistantMessage) || '…';
  }

  return (
    <div
      className={`relative cursor-pointer overflow-hidden rounded-xl border py-2 pr-3 pl-4 font-sans text-ink transition-[box-shadow,background-color] active:cursor-grabbing ${STYLES[highlight]} ${
        node.kind === 'merge' && highlight === 'none' ? '!border-graft/40' : ''
      } ${overlay ? OVERLAYS[overlay] : ''}`}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${stem}`} />
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className={`truncate text-[13px] font-semibold ${node.kind === 'merge' ? 'text-graft' : ''}`}>{title}</span>
      </div>
      <p className={`mt-1 line-clamp-2 text-xs leading-snug ${node.status === 'error' ? 'text-rust' : 'text-muted'}`}>{sub}</p>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});

const nodeTypes = { card: Card };

function firstLine(s: string) {
  return (s.split('\n').find((l) => l.trim()) ?? '').replace(/[#*`>_]/g, '').trim();
}
