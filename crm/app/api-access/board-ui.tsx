import type { CSSProperties, ReactNode } from "react";
import { bannerStyle } from "@/components/ui";

export type Submit = (form: FormData) => void;

export const BUTTON =
  "rounded-md border px-2.5 py-1 text-xs disabled:opacity-40";
export const LINE_STYLE: CSSProperties = { borderColor: "var(--line)" };
export const FIELD_STYLE: CSSProperties = { borderColor: "var(--faint)" };
export const MUTED: CSSProperties = { color: "var(--muted)" };
export const DANGER_STYLE: CSSProperties = {
  borderColor: "var(--bad)",
  color: "var(--bad)",
};

export const WarnPanel = ({ className = "", role, children }: {
  className?: string;
  role?: "alert";
  children: ReactNode;
}) => (
  <div role={role} className={`panel px-4 py-3 text-xs ${className}`}
    style={bannerStyle("var(--warn)")}>
    {children}
  </div>
);

export const ForWhom = ({ name }: { name: string | null }) =>
  name ? <span className="sr-only"> for {name}</span> : null;
