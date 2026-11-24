"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { accessClient } from "@/lib/api-access";
import { COOKIE, isValidSession } from "@/lib/auth";
import { type Outcome, performAccessAction } from "./access-action";

export async function runAccessAction(
  _previous: Outcome,
  form: FormData,
): Promise<Outcome> {
  return performAccessAction(form, {
    signedIn: async () => isValidSession((await cookies()).get(COOKIE)?.value),
    client: accessClient,
    refresh: () => revalidatePath("/api-access"),
  });
}
