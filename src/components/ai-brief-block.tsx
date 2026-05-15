"use client";

import { CopyButton } from "@/components/copy-button";

/**
 * AI-assist tiles for /contribute. Two paths, same skill content.
 * Renders as a vertical stack so it can sit inside a card column.
 */
export function AiBriefBlock() {
  return (
    <div id="ai-assist" className="scroll-mt-20 flex flex-col gap-4">
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
      <p className="text-xs text-ink-muted leading-relaxed">
        If you have already cloned the repo, Claude Code picks up the same skill
        from <code className="font-mono">.claude/skills/contribute-benchmark/</code> without any install.
      </p>
    </div>
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
    <div className="border border-rule rounded-lg bg-paper p-5 flex flex-col gap-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        {tag}
      </p>
      <p className="display text-base text-ink leading-tight">{title}</p>
      <p className="text-sm text-ink-soft leading-relaxed">{desc}</p>
      {code && (
        <pre className="overflow-x-auto border border-rule rounded bg-paper-soft px-3 py-2 font-mono text-[11px] text-ink leading-relaxed">
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
