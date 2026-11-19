import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { canBranchFrom, contextChain, getChildren, type ChatNode, type GraphIndex, type ToolStep } from '@llmb/shared';
import { latestLeaf, useIndex, useStore } from '../store';

export function ChatPanel() {
  const index = useIndex();
  const selectedId = useStore((s) => s.selectedId);
  const chain = useMemo(
    () => (selectedId && index.byId.has(selectedId) ? contextChain(index, selectedId) : []),
    [index, selectedId],
  );
  const selected = selectedId ? index.byId.get(selectedId) : undefined;

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastText = chain.at(-1)?.assistantMessage.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chain.length, lastText, selectedId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-2 py-6 sm:px-6">
        {chain.length <= 1 ? (
          <div className="mx-auto mt-[18vh] max-w-md text-center">
            <p className="text-2xl font-semibold tracking-tight">What do you want to think through?</p>
            <p className="mt-2 text-muted">
              Every message is a point you can return to. Go back to any of them to try a different direction.
            </p>
          </div>
        ) : (
          // The stem: one line down the conversation, matching the highlighted path in the graph.
          <div className="relative mx-auto max-w-[44rem]">
            <div className="pointer-events-none absolute top-3 bottom-3 left-[11px] z-10 w-0.5 rounded-full bg-moss/35" aria-hidden />
            <div className="space-y-2">
              {chain.map((n) => (n.kind === 'root' ? null : <Turn key={n.id} node={n} index={index} />))}
            </div>
          </div>
        )}
        {selected && (
          <div className="mx-auto max-w-[44rem]">
            <ContinuationHint node={selected} index={index} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {selected && <Composer node={selected} index={index} />}
    </div>
  );
}

function Turn({ node, index }: { node: ChatNode; index: GraphIndex }) {
  const selectedId = useStore((s) => s.selectedId);
  const { select, askDelete, startMerge } = useStore.getState();
  const isSelected = node.id === selectedId;
  const kids = getChildren(index, node.id);

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    askDelete(node.id);
  };
  const onMerge = (e: React.MouseEvent) => {
    e.stopPropagation();
    startMerge(node.id);
  };

  return (
    <div
      onClick={() => select(node.id)}
      className={`group relative cursor-pointer rounded-2xl py-3 pr-4 pl-10 transition-colors ${
        isSelected ? 'bg-surface shadow-[0_1px_0_var(--color-line)]' : 'hover:bg-surface/60'
      }`}
      title="Click to return to this point in the conversation"
    >
      <span
        aria-hidden
        className={`absolute top-[18px] left-[6px] z-20 rounded-full ring-4 transition-all ${isSelected ? 'ring-surface' : 'ring-paper'} ${
          node.kind === 'merge' ? 'bg-graft' : 'bg-moss'
        } ${isSelected ? 'h-3.5 w-3.5 -translate-x-[1px] -translate-y-[1px]' : 'h-3 w-3'}`}
      />
      {node.kind === 'merge' ? (
        <MergeCard node={node} />
      ) : (
        <>
          <p className="text-[15px] leading-relaxed font-semibold whitespace-pre-wrap">{node.userMessage}</p>
          <div className="mt-2">
            <Assistant node={node} />
          </div>
        </>
      )}

      <div className="mt-2 flex min-h-5 items-center gap-1 text-xs text-muted">
        {kids.length > 1 && <BranchChips index={index} kids={kids} />}
        {node.status === 'done' && (
          <button
            className="btn-ghost ml-auto !px-2 !py-0.5 !text-xs opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:!text-graft focus:opacity-100"
            onClick={onMerge}
            title="Merge this branch with another (pick it in the graph)"
          >
            Merge…
          </button>
        )}
        <button
          className={`btn-ghost !px-2 !py-0.5 !text-xs ${node.status === 'done' ? '' : 'ml-auto'} opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:!text-rust focus:opacity-100`}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function Assistant({ node }: { node: ChatNode }) {
  const retry = useStore((s) => s.retry);
  return (
    <div>
      {node.actions?.length ? <Actions steps={node.actions} /> : null}
      {node.assistantMessage ? (
        <div className="markdown text-[15px] text-ink/90">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.assistantMessage}</ReactMarkdown>
        </div>
      ) : node.status === 'streaming' ? (
        <span className="animate-pulse text-muted">Thinking…</span>
      ) : null}
      {node.status === 'error' && (
        <div className="mt-2 flex items-center gap-3 rounded-xl bg-rust-soft px-3 py-2 text-sm text-rust">
          <span>{node.error ?? 'Something went wrong.'}</span>
          <button
            className="btn ml-auto"
            onClick={(e) => {
              e.stopPropagation();
              void retry(node.id);
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

/** Tree edits the assistant made while writing this reply. */
function Actions({ steps }: { steps: ToolStep[] }) {
  return (
    <ul className="mb-2 space-y-1 text-sm" aria-label="Changes made to the tree">
      {steps.map((s, i) => (
        <li key={i} className={`flex gap-2 ${s.ok ? 'text-moss-deep' : 'text-rust'}`}>
          <span aria-hidden className="w-3 shrink-0 text-center">{s.ok ? '✓' : '✗'}</span>
          <span>{s.text}</span>
        </li>
      ))}
    </ul>
  );
}

function MergeCard({ node }: { node: ChatNode }) {
  const select = useStore((s) => s.select);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-graft">
        <span>Merged branches</span>
        {node.parentIds.map((p, i) => (
          <button
            key={p}
            className="rounded-full bg-graft-soft px-2.5 py-0.5 text-xs font-medium text-graft hover:bg-graft/15"
            onClick={(e) => {
              e.stopPropagation();
              select(p);
            }}
          >
            Go to branch {String.fromCharCode(65 + i)}
          </button>
        ))}
      </div>
      {node.mergeInstruction && <p className="mb-2 text-sm text-muted">Instruction: {node.mergeInstruction}</p>}
      <Assistant node={node} />
    </div>
  );
}

function BranchChips({ index, kids }: { index: GraphIndex; kids: string[] }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  return (
    <span className="flex items-center gap-1">
      <span className="mr-1">Branches here</span>
      {kids.map((k, i) => {
        const onPath = selectedId != null && isOnPath(index, k, selectedId);
        return (
          <button
            key={k}
            className={`h-5 min-w-5 rounded-full px-1.5 text-[11px] font-semibold ${
              onPath ? 'bg-moss text-white' : 'bg-ink/5 text-muted hover:bg-moss-soft hover:text-moss-deep'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              select(latestLeaf(index, k));
            }}
            title={index.byId.get(k)?.userMessage}
          >
            {i + 1}
          </button>
        );
      })}
    </span>
  );
}

function isOnPath(index: GraphIndex, nodeId: string, selectedId: string) {
  return contextChain(index, selectedId).some((n) => n.id === nodeId);
}

/** When you've gone back to an earlier point, show where the conversation continues. */
function ContinuationHint({ node, index }: { node: ChatNode; index: GraphIndex }) {
  const select = useStore((s) => s.select);
  const kids = getChildren(index, node.id);
  if (!kids.length) return null;
  return (
    <div className="mt-4 ml-10 rounded-2xl border border-dashed border-moss/40 p-4 text-sm text-moss-deep">
      <p>
        You're at an earlier point. This message continues in {kids.length} branch{kids.length > 1 ? 'es' : ''}.
        Sending a message here starts a new branch.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {kids.map((k) => {
          const child = index.byId.get(k);
          return (
            <button key={k} className="btn max-w-xs truncate" onClick={() => select(latestLeaf(index, k))}>
              {child?.kind === 'merge' ? 'Merged branch' : child?.userMessage}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Composer({ node, index }: { node: ChatNode; index: GraphIndex }) {
  const send = useStore((s) => s.send);
  const [text, setText] = useState('');
  const blocked = !canBranchFrom(node);
  const branching = getChildren(index, node.id).length > 0;

  const submit = () => {
    if (blocked || !text.trim()) return;
    void send(text.trim());
    setText('');
  };

  return (
    <div className="px-2 pb-1 sm:px-6">
      <div className="mx-auto flex max-w-[44rem] items-end gap-2 rounded-3xl border border-line bg-surface p-2 pl-4 transition-colors focus-within:border-moss/60">
        <textarea
          aria-label="Message"
          className="max-h-60 min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-muted/80 focus-visible:outline-none disabled:cursor-not-allowed"
          rows={Math.min(8, text.split('\n').length)}
          placeholder={
            node.status === 'streaming'
              ? 'Waiting for the reply…'
              : node.status === 'error'
                ? 'Retry the failed reply first'
                : branching
                  ? 'Send to start a new branch from here…'
                  : 'Message…'
          }
          value={text}
          disabled={blocked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn-primary h-10 shrink-0" disabled={blocked || !text.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
