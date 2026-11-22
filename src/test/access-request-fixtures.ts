import {
  type AccessRequest,
  type Approved,
  type Decision,
  decide,
  openRequest,
} from "@/lib/api-access/access-request";

export const TEST_REQUESTER = {
  email: "ana.ribeiro@example.com",
  name: "Ana Ribeiro",
  website: "https://analytics.example.com/rpc",
  useCase: "RPC latency table refreshed every 5 minutes from our server.",
};

export const PENDING_REQUEST = openRequest({
  id: "6f1c2b9e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
  requester: TEST_REQUESTER,
  tokenHash: "a".repeat(64),
  now: 1,
});

export function reach(
  decisions: Decision[],
  from: AccessRequest = PENDING_REQUEST,
): AccessRequest {
  return decisions.reduce<AccessRequest>((req, d) => {
    const out = decide(req, d, 2);
    if (!out.ok) throw new Error(`cannot reach ${d.to}`);
    return out.next;
  }, from);
}

function approvedFixture(): Approved {
  const approved = reach([{ to: "approved" }]);
  if (approved.status !== "approved") throw new Error("not approved");
  return approved;
}

export const APPROVED_REQUEST = approvedFixture();
