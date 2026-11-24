import type { TeamDelivery, TeamMessage } from "@/lib/team-notify";
import type { ApiAccess } from "./api-access";
import { ADMISSIONS, requesterGate } from "./http";
import { submitRequest } from "./requester-api";
import type { Defer } from "./defer";
import { createQueueFullAlert, createRequestAnnouncer } from "./team-alerts";
import { queueFullMessage } from "./team-message";

type RequestRouteSetup = {
  access: () => ApiAccess;
  now: () => number;
  defer: Defer;
  notify: (message: TeamMessage) => Promise<TeamDelivery>;
};

export function createRequestRoute({
  access,
  now,
  defer,
  notify,
}: RequestRouteSetup) {
  const onQueueFull = createQueueFullAlert({
    now,
    send: () => notify(queueFullMessage()),
    defer,
  });
  const onSubmitted = createRequestAnnouncer({ now, notify, defer });
  return function submit(req: Request): Promise<Response> {
    return submitRequest(req, {
      access: access(),
      now: now(),
      gate: requesterGate(req, ADMISSIONS.request),
      onSubmitted,
      onQueueFull,
    });
  };
}
