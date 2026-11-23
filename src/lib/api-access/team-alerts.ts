import { logAtMost } from "@/lib/rate-limit";
import type { TeamDelivery, TeamMessage } from "@/lib/team-notify";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/time-constants";
import type { AccessRequest } from "./access-request";
import { ANNOUNCED_PER_HOUR } from "./contract";
import type { Defer } from "./defer";
import { moreRequestsMessage, newRequestMessage } from "./team-message";

const RETRY_AFTER_FAILURE_MS = MS_PER_MINUTE;
const FAILURE_LOGS_PER_MINUTE = 5;

type Delivery = {
  defer: Defer;
  send: () => Promise<TeamDelivery>;
  what: string;
  log: string;
  onFailed: () => void;
};

async function sendTwice(send: () => Promise<TeamDelivery>) {
  const first = await send();
  return first === "failed" ? send() : first;
}

function deliverLater({ defer, send, what, log, onFailed }: Delivery): void {
  defer(async () => {
    const delivery = await sendTwice(send);
    if (delivery === "sent") return;
    if (delivery === "unconfigured") {
      logAtMost(FAILURE_LOGS_PER_MINUTE, log, () =>
        console.error("api access", what, "not announced: no team channel"));
      return;
    }
    onFailed();
    logAtMost(FAILURE_LOGS_PER_MINUTE, log, () =>
      console.error("api access", what, delivery === "unsure"
        ? "may not have been announced: timeout"
        : `not announced: ${delivery}`));
  });
}

type QueueAlertSetup = {
  now: () => number;
  send: () => Promise<TeamDelivery>;
  defer: Defer;
};

export function createQueueFullAlert({ now, send, defer }: QueueAlertSetup) {
  let lastAlertAt = Number.NEGATIVE_INFINITY;
  return function alertQueueFull(): void {
    if (now() - lastAlertAt < MS_PER_HOUR) return;
    lastAlertAt = now();
    deliverLater({
      defer,
      send,
      what: "queue full",
      log: "api-access-queue-full-delivery",
      onFailed: () => {
        lastAlertAt = now() - MS_PER_HOUR + RETRY_AFTER_FAILURE_MS;
      },
    });
  };
}

type AnnouncerSetup = {
  now: () => number;
  notify: (message: TeamMessage) => Promise<TeamDelivery>;
  defer: Defer;
};

export function createRequestAnnouncer({
  now,
  notify,
  defer,
}: AnnouncerSetup) {
  let windowStart = Number.NEGATIVE_INFINITY;
  let announced = 0;
  let noted = false;

  function post(message: TeamMessage, what: string, release: () => void) {
    const postedIn = windowStart;
    deliverLater({
      defer,
      send: () => notify(message),
      what,
      log: "api-access-request-delivery",
      onFailed: () => {
        if (postedIn === windowStart) release();
      },
    });
  }

  return function announceRequest(request: AccessRequest): void {
    if (now() - windowStart >= MS_PER_HOUR) {
      windowStart = now();
      announced = 0;
      noted = false;
    }
    if (announced < ANNOUNCED_PER_HOUR) {
      announced += 1;
      const what = `request ${request.id}`;
      post(newRequestMessage(request.requester), what, () => {
        announced -= 1;
      });
      return;
    }
    if (noted) return;
    noted = true;
    post(moreRequestsMessage(), "more requests note", () => {
      noted = false;
    });
  };
}
