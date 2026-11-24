import type { KeyBody, TokenBody } from "./contract";
import type { KeyView, RequesterView } from "./requester-view";
import { minutesText, minutesToWait } from "./retry-wait";
import {
  type Answer,
  type ApprovedView,
  type ShownKey,
  type Trouble,
  isView,
  keyChangedElsewhere,
  keyOutcome,
  keyRequest,
  troubleOf,
} from "./status-answers";

type Kid = Node | string | null;
type Note = Kid | ((view: RequesterView) => Kid);
type Action = (pressed: HTMLButtonElement) => void | Promise<void>;

const CALL_TIMEOUT_MS = 15_000;

function mountPoint(): HTMLElement {
  const node = document.getElementById("state");
  if (!node) throw new Error("status page markup has no #state element");
  return node;
}

function setting(name: string): string {
  const value = root.dataset[name];
  if (!value) throw new Error(`status page markup has no data-${name}`);
  return value;
}

const root = mountPoint();
const config = {
  contact: setting("contact"),
  keyLimit: setting("keyLimit"),
  oldKeyDelay: setting("oldKeyDelay"),
  newKeyDelay: setting("newKeyDelay"),
  declinedKept: setting("declinedKept"),
  tokenPattern: new RegExp(setting("tokenPattern")),
  form: setting("form"),
  statusRoute: setting("statusRoute"),
  keyRoute: setting("keyRoute"),
};
let focusNextState = false;
let keyOnScreen = false;
const token = location.hash.slice(1);

const when = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(ms) + " UTC";

const waitText = (seconds: number) => minutesText(minutesToWait(seconds));

function el(
  tag: string,
  attrs: Record<string, string> | null,
  ...kids: Kid[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const kid of kids) if (kid !== null) node.append(kid);
  return node;
}

function button(label: string, action: Action, look = ""): HTMLElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (look) node.className = look;
  node.addEventListener("click", () => {
    void action(node);
  });
  return node;
}

const p = (text: Kid, look?: string) =>
  el("p", look ? { class: look } : null, text);
const row = (...kids: Kid[]) => el("div", { class: "row" }, ...kids);

const CHANGED_ID = "changed-meanwhile";
const CHECKED_ID = "checked-at";

const heading = (text: string) =>
  el("h2", { class: "state", tabindex: "-1" }, text);
const notice = (...kids: Kid[]) => el("div", { class: "callout" }, ...kids);
const mail = () => el("a", { href: `mailto:${config.contact}` },
  config.contact);
const contact = (lead: string) => el("p", { class: "small" }, lead, mail(),
  ".");
const newRequest = () =>
  el("p", { class: "small" },
    "The public API still works without a key. You can ",
    el("a", { href: config.form }, "send a new request"),
    " or write to ", mail(), ".");

function copier(value: string, label: string, fallback: string): Kid[] {
  const copyStatus = el("p", { class: "small", "aria-live": "polite" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copyStatus.textContent = "Copied.";
    } catch {
      copyStatus.textContent = fallback;
    }
  };
  return [row(button(label, copy)), copyStatus];
}

const reload = (label: string) =>
  button(label, (pressed) => {
    focusNextState = true;
    pressed.disabled = true;
    pressed.textContent = "Checking…";
    return load(el("p", { class: "small", id: CHECKED_ID },
      `Checked ${when(Date.now())}.`));
  }, "ghost");

function show(...nodes: Kid[]): void {
  const acted = focusNextState || root.contains(document.activeElement);
  focusNextState = false;
  keyOnScreen = false;
  root.replaceChildren(...nodes.filter((n) => n !== null));
  root.setAttribute("aria-busy", "false");
  const title = root.querySelector<HTMLElement>("h2");
  const notes = [CHANGED_ID, CHECKED_ID]
    .filter((id) => root.querySelector(`#${id}`));
  if (notes.length > 0) {
    title?.setAttribute("aria-describedby", notes.join(" "));
  }
  if (acted) title?.focus();
}

async function call(
  path: string,
  sent: TokenBody | KeyBody,
): Promise<Answer> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sent),
    cache: "no-store",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

function decision(view: RequesterView): [string, number] | null {
  switch (view.status) {
    case "pending":
      return null;
    case "approved":
      return ["Approved", view.approvedAt];
    case "declined":
      return ["Declined", view.declinedAt];
    case "revoked":
      return ["Revoked", view.revokedAt];
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

function summary(view: RequesterView): HTMLElement[] {
  const decided = decision(view);
  return [
    el("h3", null, "Your request"),
    el("dl", null,
      el("dt", null, "Requested"), el("dd", null, when(view.requestedAt)),
      ...(decided
        ? [el("dt", null, decided[0]), el("dd", null, when(decided[1]))]
        : []),
      el("dt", null, "Email"), el("dd", null, view.email),
      el("dt", null, "Site"), el("dd", null, view.website)),
  ];
}

function unknownLink(): void {
  show(heading("Status link not recognised"),
    p("This status link does not match any current request."),
    p("Check that you copied the whole link, including everything after the"
      + " # sign. If the team sent you a new status link, the old one no"
      + " longer works. A declined request is deleted"
      + ` ${config.declinedKept}, and its link stops working.`, "small"),
    newRequest());
}

function failed(note: Kid = null): void {
  show(heading("Your request could not be loaded"), note,
    p("We could not load your request from our server. Try again in a few"
      + " minutes."),
    row(reload("Try again")),
    contact("If this keeps happening, write to us from the email you used: "));
}

type TooMany = { title: string; lead: string; back: string };

function tooMany(
  { title, lead, back }: TooMany,
  seconds: number,
  note: Kid,
): void {
  show(heading(title), note,
    p(`${lead} Try again in ${waitText(seconds)}.`),
    row(reload(back)));
}

function unreadable(): void {
  show(heading("Your request cannot be read"),
    p("Our server found your request but cannot read it. This is on our"
      + " side, and nothing was changed."),
    contact("Write to us from the email you used, and we will fix it: "));
}

function unconfirmed(): void {
  show(heading("We could not confirm your new key"),
    p("Our server did not confirm that your key was created. It may have"
      + " been created without being shown to you."),
    p("Press Check again. If the page then shows a key in use that you never"
      + " saw, replace it."),
    row(reload("Check again")));
}

function changedMeanwhile(elsewhere: boolean): HTMLElement {
  const text = elsewhere
    ? "Your key was changed from another tab or window, so no new key is"
      + " shown here. If you did not save it, replace it below."
    : "Your request changed while this page was open. This is its current"
      + " state.";
  return el("div", { class: "callout", id: CHANGED_ID }, text);
}

function createKey(view: ApprovedView): Action {
  return async (pressed) => {
    focusNextState = true;
    root.querySelectorAll("button").forEach((b) => {
      b.disabled = true;
    });
    pressed.textContent = "Creating your key…";
    const sent = keyRequest(view, token);
    let res: Answer;
    try {
      res = await call(config.keyRoute, sent);
    } catch {
      return unconfirmed();
    }
    const outcome = keyOutcome(res);
    switch (outcome.kind) {
      case "shown":
        return keyShown(outcome.shown);
      case "changed":
        return load((fresh) =>
          changedMeanwhile(keyChangedElsewhere(fresh, sent)));
      case "trouble":
        return showTrouble(outcome.trouble, KEY_SCREENS);
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  };
}

type TroubleScreens = {
  limited: TooMany;
  busy: TooMany;
  failed: (note: Kid) => void;
};

const STATUS_SCREENS: TroubleScreens = {
  limited: {
    title: "Too many attempts",
    lead: "This link was checked too many times in the last minute, or"
      + " too many checks came from your network.",
    back: "Try again",
  },
  busy: {
    title: "Too many status checks",
    lead: "Too many status checks reached us in the last minute.",
    back: "Try again",
  },
  failed,
};

const KEY_SCREENS: TroubleScreens = {
  limited: {
    title: "Too many attempts",
    lead: "This link was used too many times in the last minute, or too"
      + " many attempts came from your network. No key was created.",
    back: "Back to my request",
  },
  busy: {
    title: "Too many key requests",
    lead: "Too many keys were requested in the last minute. No key was"
      + " created.",
    back: "Back to my request",
  },
  failed: unconfirmed,
};

function showTrouble(
  trouble: Trouble,
  screens: TroubleScreens,
  note: Kid = null,
): void {
  switch (trouble.kind) {
    case "unknown_link":
      return unknownLink();
    case "limited":
    case "busy":
      return tooMany(screens[trouble.kind], trouble.seconds, note);
    case "unreadable":
      return unreadable();
    case "failed":
      return screens.failed(note);
    default: {
      const unreachable: never = trouble;
      return unreachable;
    }
  }
}

function keyShown({ key, view }: ShownKey): void {
  show(heading("Your new API key"),
    notice(el("strong", null, "Copy your key now."),
      " This is the only time it is shown. We keep only a fingerprint of it,"
      + " so we cannot show it again; if you lose it, replace it from this"
      + " page."),
    el("code", { class: "secret" }, key),
    ...copier(key, "Copy key", "Select the key above and copy it."),
    p("Send it in the Authorization header from your server. It starts"
      + ` working within ${config.newKeyDelay}:`, "small"),
    el("code", { class: "secret" }, `Authorization: Bearer ${key}`),
    row(reload("I have saved my key")),
    ...summary(view));
  keyOnScreen = true;
}

function confirmReplace(view: ApprovedView, key: KeyView): Action {
  return () => show(heading("Replace your key"),
    el("div", { class: "callout bad" },
      el("strong", null, `Replace the key ending in ${key.last4}?`),
      " It can stop working right away, and stops at the latest within"
      + ` ${config.oldKeyDelay}. Have your deploy ready before you replace`
      + " it: the new key is shown once, on the next screen."),
    row(button("Replace my key", createKey(view), "danger"),
      button("Keep my current key", () => render(view), "ghost")),
    ...summary(view));
}

function approved(view: ApprovedView, note: Kid): Kid[] {
  const key = view.key;
  if (!key) {
    return [heading("Approved: create your key"), note,
      p("Your key is shown once, right after you create it. Have somewhere"
        + " safe to paste it, such as your server's environment variables."),
      row(button("Create my API key", createKey(view)))];
  }
  return [heading("Key in use"), note,
    el("dl", null,
      el("dt", null, "Your key"),
      el("dd", { class: "mono" }, `ocb_…${key.last4}`),
      el("dt", null, "Created"), el("dd", null, when(key.createdAt)),
      el("dt", null, "Limit"), el("dd", null, config.keyLimit)),
    row(button("Replace my key", confirmReplace(view, key), "ghost"))];
}

function pending(view: RequesterView, note: Kid): Kid[] {
  return [heading("Waiting for review"), note,
    p("A person reads every request. The decision, and the button to"
      + " create your key, appear on this page. We may also write to"
      + ` ${view.email}, but this page is the place to check.`),
    notice(el("strong", null, "Save this status link now."),
      " It is the only way to create your key. We only email a status link"
      + " if you ask us for a new one."),
    ...copier(location.href, "Copy status link", "Copy the address from"
      + " your browser's address bar."),
    row(reload("Check for a decision")),
    contact("If you lose this link, write to us from the email you used: ")];
}

function stateOf(view: RequesterView, note: Kid): Kid[] {
  switch (view.status) {
    case "pending":
      return pending(view, note);
    case "approved":
      return approved(view, note);
    case "declined":
      return [heading("Request declined"), note,
        p("Reason given", "small"), p(view.reason, "reason"),
        p("This request and its status link will be deleted on"
          + ` ${when(view.deletedAt)}. Copy the reason now if you want to`
          + " keep it.", "small"),
        newRequest()];
    case "revoked":
      return [heading("Access revoked"), note,
        p((view.lastKey
          ? "Your access was revoked, along with the key ending in"
            + ` ${view.lastKey.last4}.`
          : "Your access was revoked.")
          + " Calls without a key still work at the public limit."),
        contact("Write to us if you think this is a mistake: ")];
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

function render(view: RequesterView, note: Kid = null): void {
  show(...stateOf(view, note), ...summary(view));
}

async function load(note: Note = null): Promise<void> {
  root.setAttribute("aria-busy", "true");
  if (!config.tokenPattern.test(token)) return unknownLink();
  const retried = typeof note === "function" ? null : note;
  let res: Answer;
  try {
    res = await call(config.statusRoute, { token });
  } catch {
    return failed(retried);
  }
  if (res.status === 200 && isView(res.body)) {
    const view = res.body;
    return render(view, typeof note === "function" ? note(view) : note);
  }
  showTrouble(troubleOf(res), STATUS_SCREENS, retried);
}

function loading(): void {
  root.replaceChildren(
    el("p", { class: "sr-only" }, "Loading your request…"),
    el("div", { class: "skeleton" }),
    el("div", { class: "skeleton" }),
    el("div", { class: "skeleton short" }));
}

window.addEventListener("beforeunload", (event) => {
  if (keyOnScreen) event.preventDefault();
});
window.addEventListener("hashchange", () => location.reload());
loading();
void load();
