"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/** One `not_found` event per 404 render: the path that missed and where
 *  the visitor came from, so broken inbound links and dead internal links
 *  surface on the CRM instead of in a crawl report weeks later. */
export function NotFoundPing() {
  useEffect(() => {
    track("not_found", {
      path: window.location.pathname,
      referrer: document.referrer ? new URL(document.referrer).host : "",
    });
  }, []);
  return null;
}
