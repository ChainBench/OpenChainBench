/**
 * Test script: validates GMX v2 funding rate keys + DataStore reads.
 * Run: npx ts-node --transpile-only scripts/test-gmx-funding.ts
 */

import { keccak256 } from "js-sha3";
import * as https from "https";

const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const GMX_DATASTORE = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const GMX_MARKETS: Record<string, string> = {
  "0x47c031236e19d024b42f8AE6780E44A573170703": "BTC",
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336": "ETH",
  "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9": "SOL",
  "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407": "ARB",
  "0x7f1fa204bb700853D36994DA19F830b6Ad18d232": "LINK",
  "0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4": "DOGE",
  "0xD9535bB5f58A1a75032416F2dFe7880C30575a41": "XRP",
};

const GMX_MARKET_LONG_TOKEN: Record<string, string> = {
  "0x47c031236e19d024b42f8AE6780E44A573170703": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407": "0x912CE59144191C1204E64559FE8253a0e49E6548",
  "0x7f1fa204bb700853D36994DA19F830b6Ad18d232": "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  "0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "0xD9535bB5f58A1a75032416F2dFe7880C30575a41": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

function jsonRpc(body: object): Promise<{ result?: string; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(ARB_RPC);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function callGetUint(storageKey: string): Promise<bigint> {
  const keyHex = storageKey.replace("0x", "").padStart(64, "0");
  const calldata = "0xbd02d0f5" + keyHex; // selector for getUint(bytes32)
  const res = await jsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: GMX_DATASTORE, data: calldata }, "latest"],
  });
  if (!res.result || res.result === "0x") return BigInt(0);
  return BigInt(res.result);
}

function gmxStringBase(str: string): string {
  const enc = new Uint8Array(96);
  enc[31] = 0x20;
  enc[63] = str.length;
  Buffer.from(str, "utf8").copy(Buffer.from(enc.buffer), 64);
  return keccak256(Array.from(enc));
}

function computeFundingFactorKey(marketAddr: string): string {
  const base = gmxStringBase("FUNDING_FACTOR");
  const enc = new Uint8Array(64);
  Buffer.from(base, "hex").copy(Buffer.from(enc.buffer), 0);
  Buffer.from(marketAddr.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 44);
  return "0x" + keccak256(Array.from(enc));
}

function computeOpenInterestKey(marketAddr: string, collateralToken: string, isLong: boolean): string {
  const base = gmxStringBase("OPEN_INTEREST");
  const enc = new Uint8Array(128);
  Buffer.from(base, "hex").copy(Buffer.from(enc.buffer), 0);
  Buffer.from(marketAddr.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 44);
  Buffer.from(collateralToken.replace("0x", "").toLowerCase(), "hex").copy(Buffer.from(enc.buffer), 76);
  enc[127] = isLong ? 1 : 0;
  return "0x" + keccak256(Array.from(enc));
}

async function main() {
  console.log("=== GMX v2 Funding Rate Test ===");
  console.log("DataStore:", GMX_DATASTORE, "\n");

  for (const [marketAddr, coin] of Object.entries(GMX_MARKETS)) {
    const longToken = GMX_MARKET_LONG_TOKEN[marketAddr];
    if (!longToken) continue;

    const [ffRaw, longsOILong, longsOIShort, shortsOIShort, shortsOILong] = await Promise.all([
      callGetUint(computeFundingFactorKey(marketAddr)),
      callGetUint(computeOpenInterestKey(marketAddr, longToken, true)),
      callGetUint(computeOpenInterestKey(marketAddr, USDC_ARB, true)),
      callGetUint(computeOpenInterestKey(marketAddr, USDC_ARB, false)),
      callGetUint(computeOpenInterestKey(marketAddr, longToken, false)),
    ]);

    const longsOI = longsOILong + longsOIShort;
    const shortsOI = shortsOIShort + shortsOILong;
    const totalOI = longsOI + shortsOI;

    if (totalOI === BigInt(0) || ffRaw === BigInt(0)) {
      console.log(`${coin}: OI or fundingFactor = 0 (no data)`);
      continue;
    }

    const imbalance = longsOI > shortsOI ? longsOI - shortsOI : shortsOI - longsOI;
    const rateScaled = ffRaw * imbalance / totalOI;
    const rate = Number(rateScaled) / 1e30;
    const inRange = rate > 1e-12 && rate < 1e-6;

    console.log(`${coin}: rate=${rate.toExponential(3)}/sec = ${(rate * 3600 * 100).toFixed(6)}%/hr  [${inRange ? "OK" : "OUT OF RANGE"}]`);
    console.log(`  fundingFactor=${ffRaw}  longsOI=${longsOI}  shortsOI=${shortsOI}`);
  }
}

main().catch(console.error);
