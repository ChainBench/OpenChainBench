"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * AI-assist block on the /contribute page. Two paths, same skill content.
 *
 * 1. Click "Copy AI brief URL" to paste it into ChatGPT, Cursor, Aider,
 *    or any LLM. The brief is a self-contained markdown at
 *    /contribute/ai-brief.md.
 * 2. Claude Code users can install the skill from ClawHub.
 */
export function AiBriefBlock() {
  return (
    <section
      id="ai-assist"
      className="mt-14 scroll-mt-20 border-y-2 border-ink/80 py-7 -mx-2 px-2"
    >
      <header className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          Optional
        </span>
        <h2 className="display text-xl sm:text-2xl text-ink leading-none">
          Drafting with AI
        </h2>
      </header>
      <p className="mt-4 max-w-3xl text-sm sm:text-base text-ink-soft leading-relaxed">
        We maintain a single source-of-truth skill that walks any agent
        through the six steps above with the exact conventions a
        reviewer will check. Pick the surface that matches your tooling.
      </p>

      <div className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2">
        <Tile
          tag="any LLM"
          title="Web brief"
          desc="Plain markdown. Paste into ChatGPT, Claude, Cursor, Aider, Codex, Continue or any chat-based agent."
          action={<CopyButton value="https://openchainbench.com/contribute/ai-brief.md" label="Copy brief URL" />}
          link={{ label: "View raw", href: "/contribute/ai-brief.md" }}
        />
        <Tile
          tag="Claude Code"
          title="ClawHub skill"
          desc="One-line install with the ClawHub CLI. The skill auto-loads as a slash command and applies the conventions on every reply."
          code="openclaw skills install openchainbench-contributor"
          action={<CopyButton value="openclaw skills install openchainbench-contributor" label="Copy install" mono />}
          link={{ label: "ClawHub listing ↗", href: "https://clawhub.ai/skills/openchainbench-contributor", external: true }}
        />
      </div>

      <p className="mt-5 max-w-3xl text-xs text-ink-muted leading-relaxed">
        If you have already cloned the repo, Claude Code picks up the same skill
        from <code className="font-mono">.claude/skills/contribute-benchmark/</code> without any install.
      </p>
    </section>
  );
}

function Tile({
  tag,
  title,
  desc,
  code,
  action,
  link,
}: {
  tag: string;
  title: string;
  desc: string;
  code?: string;
  action: React.ReactNode;
  link?: { label: string; href: string; external?: boolean };
}) {
  return (
    <div className="bg-paper p-5 flex flex-col gap-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        {tag}
      </p>
      <p className="display text-base text-ink leading-tight">{title}</p>
      <p className="text-sm text-ink-soft leading-relaxed flex-1">{desc}</p>
      {code && (
        <pre className="overflow-x-auto border border-ink/20 bg-ink/5 px-3 py-2 font-mono text-[11px] text-ink leading-relaxed">
          <code>$ {code}</code>
        </pre>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        {action}
        {link && (
          <a
            href={link.href}
            className="text-xs text-ink-muted hover:text-ink underline-offset-4 hover:underline"
            {...(link.external ? { rel: "noopener" } : {})}
          >
            {link.label}
          </a>
        )}
      </div>
    </div>
  );
}

function CopyButton({
  value,
  label,
  mono,
}: {
  value: string;
  label: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`inline-flex items-center gap-2 border border-ink/70 hover:bg-ink hover:text-paper transition-colors px-3 py-1.5 ${
        mono ? "font-mono text-[11px]" : "font-mono text-[11px] uppercase tracking-[0.16em]"
      }`}
    >
      {copied ? (
        <>
          <Check size={12} strokeWidth={2.5} />
          Copied
        </>
      ) : (
        <>
          <Copy size={12} strokeWidth={2} />
          {label}
        </>
      )}
    </button>
  );
}
