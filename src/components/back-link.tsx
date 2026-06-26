import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** "Back to <section>" link used as the lead-in row on every detail
 *  page. The pattern (ArrowLeft + small muted label) was repeated
 *  verbatim across six route files; consolidating here means the
 *  visual treatment of "back nav" lives in one place. */
interface BackLinkProps {
  href: string;
  label: string;
  className?: string;
}

const BASE_CLASS =
  "inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink";

export function BackLink({ href, label, className }: BackLinkProps) {
  const cls = className ? `${BASE_CLASS} ${className}` : BASE_CLASS;
  return (
    <Link href={href} className={cls}>
      <ArrowLeft size={14} strokeWidth={2} />
      {label}
    </Link>
  );
}
