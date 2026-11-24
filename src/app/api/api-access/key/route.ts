import { apiAccess } from "@/lib/api-access/api-access";
import { ADMISSIONS, linkGate } from "@/lib/api-access/http";
import { createKey } from "@/lib/api-access/requester-api";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return createKey(req, {
    access: apiAccess(),
    gate: linkGate(req, ADMISSIONS.key),
    now: Date.now(),
  });
}
