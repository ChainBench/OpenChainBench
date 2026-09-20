import type { NextRequest } from "next/server";
import { COOKIE, revokeSession, seeOther } from "@/lib/auth";

export async function POST(request: NextRequest) {
  await revokeSession(request.cookies.get(COOKIE)?.value);
  const res = seeOther(request, "/login");
  res.headers.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
