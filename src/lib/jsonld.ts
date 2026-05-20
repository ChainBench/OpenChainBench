/**
 * Safe serialization for inline `<script type="application/ld+json">`
 * blocks rendered via `dangerouslySetInnerHTML`.
 *
 * JSON.stringify alone does NOT escape `<`, `>`, `&`, U+2028 or U+2029.
 * A string containing `</script>` would close the surrounding script tag
 * and let the rest render as HTML - a stored-XSS vector if any field
 * inside the payload ever stops being editor-controlled.
 *
 * Today every JSON-LD field is derived from spec YAMLs or the provider
 * registry (both gated by PR review), so the escape is defense-in-depth.
 * Cheap insurance against a future regression that lets user input reach
 * any of these blocks.
 */
const LS = new RegExp("\\u2028", "g");
const PS = new RegExp("\\u2029", "g");

export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}
