import { COOKIE, seeOther } from "@/lib/auth";

export async function POST(request: Request) {
  const res = seeOther(request, "/login");
  res.headers.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
