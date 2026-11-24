"use client";

import Link from "next/link";
import { BUTTON, LINE_STYLE, MUTED, WarnPanel } from "./board-ui";

export default function ApiAccessError({
  error,
  unstable_retry: retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-5">
      <h1 className="mb-3 text-lg font-semibold">API access</h1>
      <WarnPanel role="alert">
        <p>
          This page hit an error. If you had just pressed an action, it may or
          may not have been applied: reload the list and check before trying
          again. If reloading opens the login page, your session had ended and
          the action was not applied.
        </p>
        {error.digest ? (
          <p className="mono mt-1" style={MUTED}>
            Reference for the Railway logs: {error.digest}
          </p>
        ) : null}
        <div className="mt-2 flex gap-3">
          <button type="button" onClick={retry} className={BUTTON}
            style={LINE_STYLE}>
            Reload the list
          </button>
          <Link href="/" className="self-center underline">
            Back to the CRM home
          </Link>
        </div>
      </WarnPanel>
    </div>
  );
}
