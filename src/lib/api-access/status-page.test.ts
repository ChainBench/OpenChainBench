import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import { APPROVED_REQUEST } from "@/test/access-request-fixtures";
import { withKey } from "./access-request";
import { KEY_ROUTE, SECRET_CHARS, STATUS_ROUTE } from "./contract";
import { requesterView } from "./requester-view";
import { STATUS_PAGE_HTML } from "./status-page";
import { STATUS_PAGE_SCRIPT } from "./status-page.gen";

type Kid = FakeElement | string;

class FakeElement {
  children: Kid[] = [];
  attributes = new Map<string, string>();
  clicks: (() => void)[] = [];
  dataset: Record<string, string> = {};
  disabled = false;
  type = "";
  className = "";

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...kids: Kid[]) {
    this.children.push(...kids);
  }

  replaceChildren(...kids: Kid[]) {
    this.children = kids;
  }

  get textContent(): string {
    return this.children
      .map((kid) => (typeof kid === "string" ? kid : kid.textContent))
      .join("");
  }

  set textContent(text: string) {
    this.children = [text];
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "click") this.clicks.push(listener);
  }

  focus() {}

  descendants(): FakeElement[] {
    return this.children.flatMap((kid) =>
      typeof kid === "string" ? [] : [kid, ...kid.descendants()]);
  }

  contains(node: unknown): boolean {
    return node === this || this.descendants().some((kid) => kid === node);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((kid) =>
      selector.startsWith("#")
        ? kid.attributes.get("id") === selector.slice(1)
        : kid.tagName === selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

function stateElement(): FakeElement {
  const markup = /<div id="state" ([^>]*)>/.exec(STATUS_PAGE_HTML)?.[1] ?? "";
  const root = new FakeElement("div");
  for (const [, name = "", value = ""] of markup.matchAll(
    /data-([a-z-]+)="([^"]*)"/g)) {
    root.dataset[camel(name)] = value;
  }
  return root;
}

type Reply = [number, unknown];

function openStatusPage(token: string, replies: Reply[]) {
  const root = stateElement();
  const calls: string[] = [];
  const pageListeners = new Map<string, (event: unknown) => void>();
  runInNewContext(STATUS_PAGE_SCRIPT, {
    document: {
      activeElement: null,
      getElementById: (id: string) => (id === "state" ? root : null),
      createElement: (tag: string) => new FakeElement(tag),
    },
    location: { hash: `#${token}`, href: `/status#${token}`, reload() {} },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        pageListeners.set(type, listener),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    AbortSignal: { timeout: () => undefined },
    fetch: async (path: string) => {
      calls.push(path);
      const [status, body] = replies.shift() ?? [500, null];
      return { status, json: async () => body };
    },
  });
  const press = async (label: string) => {
    const pressed = root.querySelectorAll("button")
      .find((b) => b.textContent === label);
    if (!pressed) throw new Error(`no button ${label}: ${root.textContent}`);
    for (const click of pressed.clicks) click();
    await Bun.sleep(1);
  };
  const leaving = () => {
    let held = false;
    pageListeners.get("beforeunload")?.({
      preventDefault: () => {
        held = true;
      },
    });
    return held;
  };
  return { root, calls, press, leaving };
}

const token = "A".repeat(SECRET_CHARS);
const key = `ocb_${"k".repeat(SECRET_CHARS)}`;
const approved = requesterView(APPROVED_REQUEST);
const keyed = requesterView(withKey(APPROVED_REQUEST,
  { hash: "b".repeat(64), last4: key.slice(-4), createdAt: 3 }));

test("a created key is shown once, and leaving asks first", async () => {
  const page = openStatusPage(token, [
    [200, approved],
    [201, { key, view: keyed }],
    [200, keyed],
  ]);
  await Bun.sleep(1);
  expect(page.leaving()).toBe(false);
  await page.press("Create my API key");
  const shown = page.root.querySelectorAll("code").map((c) => c.textContent);
  expect(shown).toEqual([key, `Authorization: Bearer ${key}`]);
  expect(page.leaving()).toBe(true);
  await page.press("I have saved my key");
  expect(page.root.textContent).not.toContain(key);
  expect(page.leaving()).toBe(false);
  expect(page.calls).toEqual([STATUS_ROUTE, KEY_ROUTE, STATUS_ROUTE]);
});
