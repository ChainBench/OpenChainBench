import type { TeamView } from "@/lib/api-access-contract/team-contract";

export const ROW: TeamView = {
  id: "4e2dfcc4-af9e-4d86-ade1-47d822cefa89",
  status: "approved",
  requester: {
    email: "ana.ribeiro@example.com",
    name: "Ana Ribeiro",
    website: "https://analytics.example.com/rpc",
    useCase: "RPC latency table refreshed every 5 minutes from our server.",
  },
  createdAt: 1795356120000,
  history: [
    { event: "requested", at: 1795356120000, source: "requester" },
    { event: "approved", at: 1795356180000, source: "team" },
    { event: "key_created", at: 1795356240000, source: "requester" },
    { event: "link_reissued", at: 1795356300000, source: "team" },
  ],
  decidedAt: 1795356180000,
  reason: null,
  key: { last4: "jc0H", createdAt: 1795356240000 },
};
