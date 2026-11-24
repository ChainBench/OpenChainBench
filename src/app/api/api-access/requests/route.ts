import { after } from "next/server";
import { apiAccess } from "@/lib/api-access/api-access";
import { createRequestRoute } from "@/lib/api-access/request-route";
import { notifyTeam } from "@/lib/team-notify";

export const runtime = "nodejs";

export const POST = createRequestRoute({
  access: apiAccess,
  now: Date.now,
  defer: after,
  notify: notifyTeam,
});
