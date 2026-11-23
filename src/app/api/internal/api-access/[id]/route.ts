import { apiAccess } from "@/lib/api-access/api-access";
import { actForTeam, teamGate } from "@/lib/api-access/team-api";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const refused = teamGate(req);
  if (refused) return refused;
  const { id } = await params;
  return actForTeam(req, id, { access: apiAccess(), now: Date.now() });
}
