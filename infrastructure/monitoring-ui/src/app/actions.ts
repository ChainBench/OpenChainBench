"use server";

import { revalidatePath } from "next/cache";
import { promoteBenchToMain, removeBenchFromMain, type PromoteResult } from "@/lib/promote";
import { REGISTRY } from "@/lib/registry";

export type ActionResult = PromoteResult;

function lookup(slug: string) {
  const e = REGISTRY.find((x) => x.slug === slug);
  if (e) return e;
  // Auto-discovered bench (YAML exists on main or dev but not yet in REGISTRY).
  // Promote/remove only need ocbYaml, so we synthesize a minimal entry instead
  // of throwing — keeps the row clickable from the dashboard.
  return { slug, ocbYaml: `benchmarks/${slug}.yml` };
}

export async function promoteAction(slug: string): Promise<ActionResult> {
  const entry = lookup(slug);
  const res = await promoteBenchToMain(slug, entry.ocbYaml);
  if (res.ok) revalidatePath("/");
  return res;
}

export async function removeAction(slug: string): Promise<ActionResult> {
  const entry = lookup(slug);
  const res = await removeBenchFromMain(slug, entry.ocbYaml);
  if (res.ok) revalidatePath("/");
  return res;
}
