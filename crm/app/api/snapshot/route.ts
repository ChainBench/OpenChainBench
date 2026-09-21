import { NextResponse } from "next/server";
import { readHistory, readSnapshot } from "@/lib/snapshot";

// The raw snapshot and history, for a spreadsheet or a script. Session cookie required.
export async function GET() {
  const [snapshot, history] = await Promise.all([readSnapshot(), readHistory()]);
  return NextResponse.json({ snapshot, history }, { headers: { "Cache-Control": "private, no-store" } });
}
