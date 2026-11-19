import { useStore } from '../store';

export function TopBar() {
  const trees = useStore((s) => s.trees);
  const currentTreeId = useStore((s) => s.currentTreeId);
  const { openTree, createTree, renameTree, deleteTree } = useStore.getState();
  const current = trees.find((t) => t.id === currentTreeId);

  return (
    <header className="flex items-center gap-3 px-5 py-3">
      <Mark />
      <span className="text-[15px] font-semibold tracking-tight">LLM Branching</span>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <label className="sr-only" htmlFor="tree-select">
        Conversation tree
      </label>
      <select
        id="tree-select"
        className="max-w-[16rem] truncate rounded-full border border-transparent bg-transparent py-1 pr-7 pl-2 text-sm font-medium hover:border-line"
        value={currentTreeId ?? ''}
        onChange={(e) => void openTree(e.target.value)}
      >
        {trees.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      {current && (
        <>
          <button
            className="btn-ghost"
            onClick={() => {
              const title = window.prompt('Rename tree', current.title);
              if (title?.trim()) void renameTree(current.id, title.trim());
            }}
          >
            Rename
          </button>
          <button
            className="btn-ghost hover:!bg-rust-soft hover:!text-rust"
            onClick={() => {
              if (window.confirm(`Delete "${current.title}" and all its conversations?`)) void deleteTree(current.id);
            }}
          >
            Delete tree
          </button>
        </>
      )}
      <button className="btn-primary ml-auto" onClick={() => void createTree()}>
        New tree
      </button>
    </header>
  );
}

/** A stem that forks: the app's mark. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="text-moss">
      <path d="M7 19V4M7 12c0-3 2.5-4 8-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="4" r="2.2" fill="currentColor" />
      <circle cx="16" cy="8" r="2.2" fill="var(--color-graft)" />
      <circle cx="7" cy="19" r="2.2" fill="currentColor" />
    </svg>
  );
}
