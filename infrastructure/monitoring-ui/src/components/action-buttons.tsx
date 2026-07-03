"use client";

import { useState, useTransition } from "react";
import { promoteAction, removeAction, type ActionResult } from "@/app/actions";
import type { BenchStatus } from "@/lib/bench-state";

type Props = { slug: string; status: BenchStatus };

export function ActionButtons({ slug, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmKind, setConfirmKind] = useState<"promote" | "remove" | null>(null);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);

  function open(kind: "promote" | "remove") {
    setConfirmKind(kind);
    setTyped("");
    setResult(null);
  }
  function close() {
    setConfirmKind(null);
    setTyped("");
  }

  function run() {
    if (typed !== "PROD") return;
    const fn = confirmKind === "promote" ? promoteAction : removeAction;
    startTransition(async () => {
      const res = await fn(slug);
      setResult(res);
      if (res.ok) close();
    });
  }

  const canPromote = status === "dev_only" || status === "drift";
  const canRemove = status === "synced" || status === "drift" || status === "prod_only";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        {canPromote && (
          <button
            onClick={() => open("promote")}
            disabled={pending}
            className="text-[11px] px-2 py-1 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50"
          >
            → prod
          </button>
        )}
        {canRemove && (
          <button
            onClick={() => open("remove")}
            disabled={pending}
            className="text-[11px] px-2 py-1 rounded border border-rose-700/50 bg-rose-900/30 text-rose-300 hover:bg-rose-900/50 disabled:opacity-50"
          >
            ← remove
          </button>
        )}
      </div>
      {result && (
        <div className={`text-[10px] mt-1 ${result.ok ? "text-emerald-400" : "text-rose-400"}`}>
          <div className="flex items-start gap-1">
            <span>{result.ok ? "✓" : "✗"}</span>
            <div className="flex-1">
              <div>{result.message}</div>
              {(result.prUrl || result.actionsUrl) && (
                <div className="flex gap-2 mt-1">
                  {result.prUrl && (
                    <a
                      href={result.prUrl}
                      target="_blank"
                      rel="noopener"
                      className="underline hover:text-emerald-300"
                    >
                      view PR ↗
                    </a>
                  )}
                  {result.actionsUrl && (
                    <a
                      href={result.actionsUrl}
                      target="_blank"
                      rel="noopener"
                      className="underline hover:text-emerald-300"
                    >
                      follow CI deploy ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmKind && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={close}>
          <div onClick={(e) => e.stopPropagation()} className="bg-neutral-950 border border-neutral-700 rounded-lg p-6 max-w-md w-full">
            <h2 className="text-base font-bold mb-2">
              {confirmKind === "promote" ? "Promote to prod" : "Remove from prod"}
            </h2>
            <p className="text-sm text-neutral-400 mb-1">
              <code className="text-emerald-400">{slug}</code>
            </p>
            <p className="text-xs text-neutral-500 mb-4">
              {confirmKind === "promote"
                ? "Copies the YAML from dev to main, opens an auto-merged PR, and triggers a prod deploy."
                : "Removes the YAML from main (kept on dev), opens an auto-merged PR, and triggers a prod deploy."}
            </p>
            <label className="block text-xs text-neutral-400 mb-1">
              Type <code className="text-amber-400">PROD</code> to confirm:
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm font-mono"
              placeholder="PROD"
            />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={close} className="px-3 py-1 text-sm rounded border border-neutral-700 hover:bg-neutral-900">
                Cancel
              </button>
              <button
                onClick={run}
                disabled={typed !== "PROD" || pending}
                className="px-3 py-1 text-sm rounded border border-amber-700/50 bg-amber-900/40 text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
              >
                {pending ? "Working…" : "Confirm"}
              </button>
            </div>
            {result && !result.ok && (
              <div className="mt-3 text-xs text-rose-400">{result.message}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
