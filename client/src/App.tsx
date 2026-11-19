import { useEffect, useState } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { Dialogs } from './components/Dialogs';
import { GraphPanel } from './components/GraphPanel';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

const RESYNC_MS = 1500;

export default function App() {
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    void useStore.getState().init();
    fetch('/api/health')
      .then((r) => r.json() as Promise<{ hasApiKey: boolean; mock: boolean }>)
      .then((h) => {
        if (h.mock) setWarning('Test mode (MOCK_LLM=1): replies are fake echoes, no API calls are made.');
        else if (!h.hasApiKey) setWarning('No OPENROUTER_API_KEY set in .env. Replies will fail until it is added.');
      })
      .catch(() => setWarning('Cannot reach the server. Is it running (npm run dev)?'));
  }, []);

  // Resync: a node can be 'streaming' without this tab receiving its tokens (page reloaded
  // mid-reply, or the connection dropped). Poll the server until such nodes finish.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = useStore.getState();
      const orphan = s.streamsInFlight === 0 && Object.values(s.nodes).some((n) => n.status === 'streaming');
      if (orphan) void s.refreshTree();
    }, RESYNC_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full flex-col bg-paper font-sans text-ink">
      <TopBar />
      {warning && <div className="border-b border-line bg-moss-soft px-5 py-1.5 text-sm text-moss-deep">{warning}</div>}
      {error && (
        <div role="alert" className="flex items-center gap-3 border-b border-rust/20 bg-rust-soft px-5 py-2 text-sm text-rust">
          <span>{error}</span>
          <button className="btn-ghost ml-auto !text-rust" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <main className="flex min-h-0 flex-1 gap-3 p-3 pt-0">
        <section className="hidden w-[46%] overflow-hidden rounded-2xl border border-line bg-surface md:block">
          <GraphPanel />
        </section>
        <section className="min-w-0 flex-1">
          <ChatPanel />
        </section>
      </main>
      <Dialogs />
    </div>
  );
}
