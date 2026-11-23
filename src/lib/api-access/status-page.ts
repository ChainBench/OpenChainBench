import { createHash } from "node:crypto";
import { escapeMarkup } from "../escape-markup";
import { SITE } from "../../data/site";
import { THEME_SCRIPT } from "../theme-key";
import {
  DECLINED_KEPT,
  KEYED_PER_MINUTE,
  KEY_ROUTE,
  NEW_KEY_DELAY_SECONDS,
  OLD_KEY_DELAY,
  REQUEST_PAGE_PATH,
  STATUS_ROUTE,
  STATUS_TOKEN,
} from "./contract";
import { STATUS_PAGE_PALETTE, STATUS_PAGE_SCRIPT } from "./status-page.gen";

const CONFIG = [
  `data-contact="${escapeMarkup(SITE.email)}"`,
  `data-key-limit="${KEYED_PER_MINUTE} requests per minute per route"`,
  `data-old-key-delay="${escapeMarkup(OLD_KEY_DELAY)}"`,
  `data-declined-kept="${escapeMarkup(DECLINED_KEPT)}"`,
  `data-new-key-delay="${NEW_KEY_DELAY_SECONDS} seconds"`,
  `data-token-pattern="${escapeMarkup(STATUS_TOKEN.source)}"`,
  `data-form="${REQUEST_PAGE_PATH}"`,
  `data-status-route="${STATUS_ROUTE}"`,
  `data-key-route="${KEY_ROUTE}"`,
].join(" ");

const tokens = (palette: Record<string, string>) =>
  Object.entries(palette).map(([name, value]) => `--${name}:${value};`)
    .join("");

const STYLE = `
:root{color-scheme:light;${tokens(STATUS_PAGE_PALETTE.light)}
--sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:root.dark{color-scheme:dark;${tokens(STATUS_PAGE_PALETTE.dark)}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.55 var(--sans)}
main{max-width:640px;margin:0 auto;padding:48px 16px}
a{color:inherit;text-underline-offset:3px}
.home{display:inline-block;padding:12px 0;font-size:13px;
color:var(--ink-muted)}
h1{font-size:32px;line-height:1.1;letter-spacing:-.02em;margin:16px 0 24px}
.state{font-size:22px;line-height:1.25;margin:0 0 16px}
.state:focus{outline:none}
h3{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.18em;
color:var(--ink-soft);margin:40px 0 12px;padding-bottom:8px;
border-bottom:1px solid var(--rule-strong)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 20px;
margin:0;font-size:14px}
dt{color:var(--ink-muted)}dd{margin:0;overflow-wrap:anywhere}
p{margin:0 0 12px}.small{font-size:13px;color:var(--ink-muted)}
.reason{overflow-wrap:anywhere}
.callout{border-left:4px solid var(--accent);background:var(--accent-soft);
padding:12px 16px;border-radius:8px;font-size:14px;margin:0 0 16px}
.callout.bad{border-color:var(--bad);background:var(--paper-soft)}
.secret{display:block;font:13px/1.5 var(--mono);background:var(--paper-soft);
border:1px solid var(--rule-strong);border-radius:6px;padding:10px 12px;
overflow-wrap:anywhere;margin:12px 0}
.row{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
button{font:500 14px var(--sans);min-height:44px;padding:10px 16px;
border-radius:8px;cursor:pointer;border:1px solid var(--ink);
background:var(--ink);color:var(--paper)}
button.ghost{background:transparent;color:var(--ink);
border-color:var(--ink-muted)}
button.danger{background:var(--bad-text);border-color:var(--bad-text);
color:var(--paper)}
button:disabled{opacity:.6;cursor:not-allowed}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);
outline-offset:2px}
.skeleton{height:14px;border-radius:4px;background:var(--rule-strong);
margin:10px 0}
.skeleton.short{width:45%}.mono{font-family:var(--mono)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;
clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){
.skeleton{animation:pulse 1.2s ease-in-out infinite}}
@keyframes pulse{50%{opacity:.5}}
`;

const cspHash = (source: string) =>
  `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

export const STATUS_PAGE_POLICY = [
  "default-src 'none'",
  `script-src ${cspHash(THEME_SCRIPT)} ${cspHash(STATUS_PAGE_SCRIPT)}`,
  `style-src ${cspHash(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Your API key request · OpenChainBench</title>
<script>${THEME_SCRIPT}</script>
<style>${STYLE}</style>
</head>
<body>
<main>
<a class="home" href="/">OpenChainBench</a>
<h1>Your API key request</h1>
<div id="state" ${CONFIG}></div>
<noscript>
<p>This page needs JavaScript to read your status link. Turn JavaScript on
and reload, or write to
<a href="mailto:${escapeMarkup(SITE.email)}">${escapeMarkup(SITE.email)}</a>
from the email you used in your request.</p>
</noscript>
</main>
<script>${STATUS_PAGE_SCRIPT}</script>
</body>
</html>`;
