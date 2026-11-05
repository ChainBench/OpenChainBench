import type { ComponentProps } from "react";
import { outboundHref } from "@/lib/outbound-click";

type OutboundLinkProps = Omit<ComponentProps<"a">, "href" | "rel"> & {
  href: string;
  rel?: "sponsored" | "nofollow";
};

export function OutboundLink({ href, rel, ...props }: OutboundLinkProps) {
  return (
    <a
      {...props}
      href={outboundHref(href)}
      rel={rel ? `noopener ${rel}` : "noopener"}
    />
  );
}
