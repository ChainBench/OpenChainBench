import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * /api/report carries a reader's message and, with it, three things a
 * reporter controls: the message, the contact, and the User-Agent header.
 * Telegram's HTML mode will happily render markup out of any of them, and
 * the bot token sits in the request URL rather than a header, so a logged
 * response body would leak it.
 *
 * Read from the source: the route needs a live request and an outbound fetch
 * to execute, and what is worth pinning is the shape of the delivery rather
 * than one round trip.
 */
const SRC = readFileSync(join(import.meta.dir, "route.ts"), "utf8");

describe("report delivery", () => {
  test("prefers Telegram and keeps Slack as the fallback", () => {
    expect(SRC).toContain("process.env.TELEGRAM_BOT_TOKEN");
    expect(SRC).toContain("process.env.TELEGRAM_CHAT_ID");
    // Both must be present, or a token with no destination would look
    // configured and every report would 502.
    expect(SRC).toContain("tgToken && tgChat");
    expect(SRC).toContain("!telegram && !webhook");
  });

  test("never logs a Telegram response body, which echoes the token's URL", () => {
    const tgBlock = SRC.slice(SRC.indexOf("api.telegram.org"));
    expect(tgBlock).toContain('console.error("Telegram rejected report", res.status)');
    // The Slack path logs a body; the Telegram path must not.
    expect(tgBlock).not.toContain("await res.text()");
  });

  test("sends every reporter-controlled value through the escaper", () => {
    // slackSafe escapes &, < and >, which is exactly what HTML mode needs.
    for (const v of ["safeMessage", "safeContact", "titleLine", "referer", "ip", "ua"]) {
      expect(SRC).toContain(v);
    }
    expect(SRC).toContain('parse_mode: "HTML"');
  });

  test("respects Telegram's own message ceiling", () => {
    expect(SRC).toContain("text.slice(0, 4096)");
  });
});
