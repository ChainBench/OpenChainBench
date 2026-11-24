import { SITE_TIMEOUT_SECONDS } from "@/lib/api-access";
import { ACCESS_SITE_HOST } from "@/lib/site";
import { MUTED } from "./board-ui";

export default function ApiAccessLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-5">
      <h1 className="mb-3 text-lg font-semibold">API access</h1>
      <p role="status" className="text-sm" style={MUTED}>
        Loading requests from {ACCESS_SITE_HOST}. This can take up to{" "}
        {SITE_TIMEOUT_SECONDS} seconds.
      </p>
    </div>
  );
}
