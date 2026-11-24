import { apiAccess } from "@/lib/api-access/api-access";
import { listForTeam, teamGate } from "@/lib/api-access/team-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return teamGate(req) ??
    listForTeam(req, { access: apiAccess(), now: Date.now() });
}
