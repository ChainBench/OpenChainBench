import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutboundLink } from "./outbound-link";

const GO_HREF =
  "/go?to=https%3A%2F%2Fdrpc.org%2F%3Futm_source%3Dopenchainbench";

describe("OutboundLink", () => {
  test("sends the reader through /go without dropping the referrer", () => {
    const html = renderToStaticMarkup(
      <OutboundLink href="https://drpc.org" className="lnk">
        dRPC
      </OutboundLink>,
    );
    expect(html).toContain(`href="${GO_HREF}"`);
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('class="lnk"');
  });

  test("keeps noopener next to a sponsored rel", () => {
    const html = renderToStaticMarkup(
      <OutboundLink href="https://drpc.org" rel="sponsored" />,
    );
    expect(html).toContain('rel="noopener sponsored"');
  });
});
