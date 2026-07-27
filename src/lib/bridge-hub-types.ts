import type { ProviderType } from "@/types/benchmark";

export type CorridorKey = "Base" | "Arbitrum" | "Solana" | "HyperCore";

export const CORRIDORS: { value: CorridorKey; label: string; short: string }[] =
  [
    { value: "Base", label: "Sol → Base", short: "Sol→Base" },
    { value: "Arbitrum", label: "Base → Arb", short: "Base→Arb" },
    { value: "Solana", label: "Arb → Sol", short: "Arb→Sol" },
    { value: "HyperCore", label: "Arb → HC", short: "Arb→HC" },
  ];

export type CorridorFee = {
  corridor: CorridorKey;
  feep50: number | null;
};

export type BridgeProviderRow = {
  slug: string;
  name: string;
  type: ProviderType | undefined;
  tag: string | undefined;
  feep50: number | null;
  feep99: number | null;
  feeSuccess: number | null;
  quotep50: number | null;
  quotep99: number | null;
  quoteSuccess: number | null;
  corridors: CorridorFee[];
};

export type BridgeHubData = {
  providers: BridgeProviderRow[];
  corridors: { value: string; label: string }[];
  cheapestSlug: string | null;
  cheapestName: string | null;
  cheapestP50: number | null;
  fastestSlug: string | null;
  fastestName: string | null;
  fastestP50: number | null;
  bridgeCount: number;
  regionCount: number;
};
