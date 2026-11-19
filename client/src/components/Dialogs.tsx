import { useEffect, useMemo, useState } from 'react';
import { descendantIds, mergeInputs, type ChatNode } from '@llmb/shared';
import { nodeLabel, useIndex, useStore } from '../store';

/** Global Esc handling plus the merge and delete confirmation dialogs. */
export function Dialogs() {
  const mergeDraft = useStore((s) => s.mergeDraft);
  const deleteTarget = useStore((s) => s.deleteTarget);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useStore.getState();
      if (s.deleteTarget) s.cancelDelete();
      else if (s.mergeDraft) s.cancelMerge();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (deleteTarget) return <DeleteDialog id={deleteTarget} />;
  if (mergeDraft?.b) return <MergeDialog a={mergeDraft.a} b={mergeDraft.b} />;
  return null;
}

function Modal({ children, onClose, light }: { children: React.ReactNode; onClose: () => void; light?: boolean }) {
  // `light`: keep the graph visible behind the dialog (delete preview).
  const overlay = light ? 'items-end bg-ink/10' : 'items-center bg-ink/35';
  return (
    <div className={`fixed inset-0 z-50 flex justify-center p-4 ${overlay}`} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-line bg-surface p-6 font-sans text-ink shadow-[0_24px_60px_-20px_rgba(28,38,33,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function MergeDialog({ a, b }: { a: string; b: string }) {
  const index = useIndex();
  const { cancelMerge, confirmMerge } = useStore.getState();
  const [instruction, setInstruction] = useState('');
  const inputs = useMemo(
    () => (index.byId.has(a) && index.byId.has(b) ? mergeInputs(index, a, b) : null),
    [index, a, b],
  );
  if (!inputs) return null;
  const splitAt = inputs.shared.at(-1);

  return (
    <Modal onClose={cancelMerge}>
      <h2 className="text-xl font-semibold tracking-tight">Merge two branches</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        The branches split after <b>{nodeLabel(splitAt)}</b>. The AI will summarize what each branch added after that
        point. The summary becomes a new node below both, and you can keep chatting from it.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {inputs.segments.map((seg, i) => (
          <BranchPreview key={i} label={`Branch ${String.fromCharCode(65 + i)}`} nodes={seg} />
        ))}
      </div>
      <label className="mt-4 block text-sm font-medium">
        Instruction (optional)
        <textarea
          className="mt-1 w-full rounded-2xl border border-line px-3 py-2 text-sm font-normal outline-none focus:border-graft/60 focus-visible:outline-none"
          rows={2}
          placeholder='e.g. "Keep the code decisions, drop the brainstorming"'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          autoFocus
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={cancelMerge}>
          Cancel
        </button>
        <button className="btn-primary !bg-graft hover:!bg-graft/85" onClick={() => void confirmMerge(instruction)}>
          Merge
        </button>
      </div>
    </Modal>
  );
}

function BranchPreview({ label, nodes }: { label: string; nodes: ChatNode[] }) {
  return (
    <div className="rounded-2xl bg-graft-soft p-3">
      <div className="mb-2 text-sm font-semibold text-graft">
        {label} <span className="font-normal text-graft/70">({nodes.length} message{nodes.length === 1 ? '' : 's'})</span>
      </div>
      <ol className="space-y-1 text-sm">
        {nodes.map((n) => (
          <li key={n.id} className="truncate">
            {nodeLabel(n)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DeleteDialog({ id }: { id: string }) {
  const index = useIndex();
  const { cancelDelete, confirmDelete } = useStore.getState();
  const node = index.byId.get(id);
  if (!node) return null;
  const below = descendantIds(index, id);
  const merges = below.filter((d) => index.byId.get(d)?.kind === 'merge').length;

  return (
    <Modal onClose={cancelDelete} light>
      <h2 className="text-xl font-semibold tracking-tight">
        Delete {below.length + 1} node{below.length ? 's' : ''}?
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        "{nodeLabel(node)}" and everything below it will be permanently deleted
        {merges > 0 && <>, including {merges} merged node{merges > 1 ? 's that depend' : ' that depends'} on it</>}. The nodes are
        highlighted in red in the graph.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={cancelDelete} autoFocus>
          Cancel
        </button>
        <button className="btn-primary !bg-rust hover:!bg-rust/85" onClick={() => void confirmDelete()}>
          Delete
        </button>
      </div>
    </Modal>
  );
}
