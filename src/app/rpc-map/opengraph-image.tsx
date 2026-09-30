/**
 * Share card for this route, re-exported rather than drawn again.
 *
 * It has to exist as a file. Next resolves opengraph-image from the route
 * segment's own file and does NOT inherit one from an ancestor segment, so
 * without this the route emits no og:image at all: verified in dev, where
 * /rwa, /rpc-map and /perps/<asset> rendered with no image meta once
 * pageMetadata stopped pinning `images` by hand. Deleting this file does not
 * fall back to ../opengraph-image, it falls back to nothing.
 *
 * The site card, which is what this page served before.
 *
 * `runtime` and `revalidate` are route segment config and are declared here
 * literally: Next refuses a re-exported one ("can't recognize the exported
 * `revalidate` field in route. It mustn't be reexported"), and the failure is
 * a 500 on every image route in the app, not just this one.
 */
export const runtime = "nodejs";
export const revalidate = 86400;
export { default, alt, size, contentType } from "../opengraph-image";
