import { after } from "next/server";
import { SITE } from "@/data/site";
import { clientKey, clientNetworkKey, rateLimit } from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/sha256";
import {
  MS_PER_MINUTE,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "@/lib/time-constants";
import { AccessStoreError } from "./access-store";
import { apiAccess } from "./api-access";
import {
  KEY_CACHE_SECONDS,
  NEW_KEY_DELAY_SECONDS,
  OUTAGE_KEY_GRACE_MINUTES,
  REQUEST_PAGE_PATH,
} from "./contract";
import { PUBLIC_PER_MINUTE, keyedPerMinute } from "./public-limits";
import { API_KEY_PATTERN } from "./secrets";
import type { Defer } from "./defer";

const WINDOW_SEC = SECONDS_PER_MINUTE;
const REFUSED_PER_NETWORK = 30;
const INDEX_TTL_MS = KEY_CACHE_SECONDS * MS_PER_SECOND;
const MISS_RELOAD_MS = NEW_KEY_DELAY_SECONDS * MS_PER_SECOND;
const STORE_PAUSE_MS = 10 * MS_PER_SECOND;
const LAST_KNOWN_MAX_MS = OUTAGE_KEY_GRACE_MINUTES * MS_PER_MINUTE;
const OCB_BEARER = /^Bearer\s+(ocb_\S*)$/i;
const OCB_CREDENTIAL = /^(?:\S+\s+)?ocb_/i;

type KeyIds = ReadonlyMap<string, string>;
type LoadKeys = () => Promise<KeyIds>;
type Loaded = { ids: KeyIds; at: number };
type Checked = { requestId: string | null } | "unchecked";

const seconds = (n: number) => (n === 1 ? "1 second" : `${n} seconds`);

type Unauthorized = {
  error: string;
  message: string;
  wwwError: string;
  tooOften: string;
};

const unauthorized = ({ error, message, wwwError }: Unauthorized) =>
  Response.json(
    { error, message },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer error="${wwwError}"`,
      },
    },
  );

const INVALID_KEY: Unauthorized = {
  error: "invalid_api_key",
  wwwError: "invalid_token",
  tooOften:
    "Too many calls from your network sent an API key that does not work.",
  message:
    "This API key does not work: it was replaced, revoked or mistyped. " +
    "This call was not served. A key created in the last few seconds can " +
    `take up to ${NEW_KEY_DELAY_SECONDS} seconds to work; retry then. ` +
    "Otherwise open the private status link of your request, or the newer " +
    "one we sent you: it shows the last 4 characters of your current key. " +
    "If you lost that link, write to " +
    `${SITE.email} from the email you used. You can also remove the ` +
    "Authorization header to call at the public limit.",
};

const MALFORMED_HEADER: Unauthorized = {
  error: "malformed_authorization",
  wwwError: "invalid_request",
  tooOften:
    "Too many calls from your network sent an Authorization header that " +
    'is not in the form "Bearer ocb_…".',
  message:
    'The Authorization header is not in the form "Bearer ocb_…", so your ' +
    "key was not read. This call was not served. Send it as " +
    "Authorization: Bearer <your key>, or remove the header to call at " +
    "the public limit.",
};

type Limited = { message: string; error?: string; unverified?: true };

function limited(
  retryAfterSec: number,
  { message, error = "rate_limited", unverified }: Limited,
): Response {
  const headers = {
    "Retry-After": String(retryAfterSec),
    "Cache-Control": "no-store",
    ...(unverified ? { "X-OCB-Key": "unverified" } : {}),
  };
  return Response.json(
    {
      error,
      retryAfterSec,
      ...(unverified ? { keyUnverified: true } : {}),
      message,
    },
    { status: 429, headers },
  );
}

const unverifiedKeyLimited = (retryAfterSec: number) =>
  limited(retryAfterSec, {
    message:
      "Your API key could not be checked just now, so this call counted " +
      "against the public limit, which is used up. This call was not " +
      `served. Retry after ${seconds(retryAfterSec)}; your key's own ` +
      "limit applies again once the check works.",
    unverified: true,
  });

const refusedTooOften = (why: Unauthorized, retryAfterSec: number) =>
  limited(retryAfterSec, {
    error: `${why.error}_limited`,
    message:
      `${why.tooOften} This call was not served. Retry after ` +
      `${seconds(retryAfterSec)}, or remove the Authorization header to ` +
      "call at the public limit.",
  });

type Capacities = { open: number; keyed: number };

const publicLimited = (retryAfterSec: number, { open, keyed }: Capacities) =>
  limited(retryAfterSec, {
    message:
      `This IP used the ${open} requests per minute allowed on this ` +
      "route without an API key. This call was not served. Retry after " +
      `${seconds(retryAfterSec)}, or request a free API key at ` +
      `${SITE.url}${REQUEST_PAGE_PATH} for ${keyed} requests per ` +
      "minute on this route.",
  });

const keyLimited = (retryAfterSec: number, keyed: number) =>
  limited(retryAfterSec, {
    message:
      `Your API key used its ${keyed} requests per minute on ` +
      "this route. This call was not served. Retry after " +
      `${seconds(retryAfterSec)}.`,
  });

type IndexSetup = { load: LoadKeys; now: () => number; defer: Defer };

function createKeyIndex({ load, now, defer }: IndexSetup) {
  let loaded: Loaded | null = null;
  let loading: Promise<Loaded | null> | null = null;
  let storeDownUntil = 0;
  let storeDown = false;

  async function reload(): Promise<Loaded | null> {
    try {
      const at = now();
      const ids = await load();
      loaded = { ids, at };
      storeDown = false;
      return loaded;
    } catch (err) {
      if (!(err instanceof AccessStoreError)) throw err;
      storeDown = true;
      storeDownUntil = now() + STORE_PAUSE_MS;
      const what = err.code === "store_unavailable" ? "unavailable" : "unread";
      console.error(`api key index ${what}`, err.code, err);
      return null;
    }
  }

  function fresh(): Promise<Loaded | null> {
    if (storeDownUntil > now()) return Promise.resolve(null);
    loading ??= reload().finally(() => {
      loading = null;
    });
    return loading;
  }

  function lastKnown(hash: string): Checked {
    if (!loaded || now() - loaded.at >= LAST_KNOWN_MAX_MS) return "unchecked";
    const requestId = loaded.ids.get(hash);
    return requestId ? { requestId } : "unchecked";
  }

  function reloadInBackground(): void {
    defer(async () => {
      try {
        await fresh();
      } catch (err) {
        console.error("api key index reload failed", err);
      }
    });
  }

  function current(): Promise<Loaded | null> {
    if (loaded && now() - loaded.at < INDEX_TTL_MS) {
      return Promise.resolve(loaded);
    }
    if (!storeDown) return fresh();
    reloadInBackground();
    return Promise.resolve(null);
  }

  return async function lookUp(key: string): Promise<Checked> {
    const hash = sha256Hex(key);
    const index = await current();
    if (!index) return lastKnown(hash);
    const requestId = index.ids.get(hash);
    if (requestId) return { requestId };
    if (now() - index.at < MISS_RELOAD_MS) return { requestId: null };
    if (storeDown) {
      reloadInBackground();
      return "unchecked";
    }
    const reloaded = await fresh();
    if (!reloaded) return "unchecked";
    return { requestId: reloaded.ids.get(hash) ?? null };
  };
}

type CallerSetup<Route extends string> = IndexSetup & {
  capacities: Readonly<Record<Route, number>>;
  keyedCapacity: (route: Route) => number;
};

export function createCallerLimit<Route extends string>(
  setup: CallerSetup<Route>,
) {
  const lookUp = createKeyIndex(setup);
  const { capacities, keyedCapacity } = setup;

  function refused(req: Request, why: Unauthorized): Response {
    const cap = rateLimit(
      clientNetworkKey(req, "api-key-refused"),
      REFUSED_PER_NETWORK,
      WINDOW_SEC,
    );
    return cap.ok
      ? unauthorized(why)
      : refusedTooOften(why, cap.retryAfterSec);
  }

  const publicBudget = (req: Request, route: Route) =>
    rateLimit(clientKey(req, route), capacities[route], WINDOW_SEC, req);

  function anonymous(req: Request, route: Route): Response | null {
    const r = publicBudget(req, route);
    if (r.ok) return null;
    const limits = { open: capacities[route], keyed: keyedCapacity(route) };
    return publicLimited(r.retryAfterSec, limits);
  }

  function unverified(req: Request, route: Route): Response | null {
    const r = publicBudget(req, route);
    return r.ok ? null : unverifiedKeyLimited(r.retryAfterSec);
  }

  return async function limitApiCall(
    req: Request,
    route: Route,
  ): Promise<Response | null> {
    const header = req.headers.get("authorization")?.trim() ?? "";
    const key = OCB_BEARER.exec(header)?.[1];
    if (!key) {
      return OCB_CREDENTIAL.test(header)
        ? refused(req, MALFORMED_HEADER)
        : anonymous(req, route);
    }
    if (!API_KEY_PATTERN.test(key)) return refused(req, INVALID_KEY);
    const found = await lookUp(key);
    if (found === "unchecked") return unverified(req, route);
    if (found.requestId === null) return refused(req, INVALID_KEY);
    const keyed = keyedCapacity(route);
    const r = rateLimit(
      `key:${found.requestId}:${route}`,
      keyed,
      WINDOW_SEC,
      req,
    );
    return r.ok ? null : keyLimited(r.retryAfterSec, keyed);
  };
}

export const limitApiCall = createCallerLimit({
  load: () => apiAccess().keyIndex(),
  now: Date.now,
  defer: after,
  capacities: PUBLIC_PER_MINUTE,
  keyedCapacity: keyedPerMinute,
});
