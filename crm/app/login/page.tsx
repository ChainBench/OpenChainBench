import { authConfigured } from "@/lib/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <p className="mono text-lg font-semibold">
        OCB <span style={{ color: "var(--accent)" }}>CRM</span>
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        OpenChainBench internal dashboard.
      </p>
      {!authConfigured() ? (
        <p className="panel mt-6 px-3 py-2 text-xs" style={{ color: "var(--bad)" }}>
          CRM_PASSWORD and CRM_SESSION_SECRET must both be set (16 characters minimum). Nobody can log in until they are.
        </p>
      ) : (
        <form action="/api/login" method="post" className="panel mt-6 space-y-3 p-4">
          <input type="hidden" name="next" value={sp.next ?? "/"} />
          <label className="block text-xs" style={{ color: "var(--muted)" }}>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </label>
          {sp.error && (
            <p className="text-xs" style={{ color: "var(--bad)" }}>
              {sp.error === "limited" ? "Too many attempts; wait 15 minutes." : "Wrong password."}
            </p>
          )}
          <button type="submit" className="w-full rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: "var(--accent)", color: "#0b0d10" }}>
            Enter
          </button>
        </form>
      )}
    </main>
  );
}
