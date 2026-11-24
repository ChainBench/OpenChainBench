import { PRIVATE_HEADERS } from "@/lib/api-access/http";
import { STATUS_PAGE_HTML } from "@/lib/api-access/status-page";

export function GET(): Response {
  return new Response(STATUS_PAGE_HTML, {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
