import json,urllib.request,sys
# id, slug, filters, why
FX=[
 ("rpc-solana-many","solana-rpc",{}, "latency, many providers"),
 ("headlag-seconds","aggregator-head-lag",{}, "unit s stored as ms"),
 ("bridge-fee-usd","bridge-fee",{}, "usd, small spread"),
 ("swaps-count-big","terminal-swap-transactions",{}, "count, large values, daily cadence"),
 ("wallets-few","trading-platform-wallets",{}, "count, few providers, daily"),
 ("l2-blocktime","l2-block-time",{}, "ms, cadence"),
 ("netfees-tiny","network-fees",{}, "tiny usd values, 20 chains"),
 ("perp-fees-bps","perp-fees",{}, "bps or pct"),
 ("hl-rpc-few","hyperliquid-rpc",{}, "latency, few providers"),
 ("rpc-cluster-12","rpc-capabilities",{}, "latency, 12 providers, cross-chain"),
]
def bridge(vals):
    idx=[i for i,v in enumerate(vals) if v is not None]
    if not idx: return []
    out=[None]*len(vals)
    for i in range(0,idx[0]+1): out[i]=vals[idx[0]]
    for a,b in zip(idx,idx[1:]):
        for j in range(a,b+1): out[j]=vals[a]+(vals[b]-vals[a])*(j-a)/(b-a)
    for j in range(idx[-1],len(vals)): out[j]=vals[idx[-1]]
    return out
index=[]
for fid,slug,flt,why in FX:
    qs="range=30d"+"".join(f"&{k}={v}" for k,v in flt.items())
    try:
        with urllib.request.urlopen(f"https://openchainbench.com/api/series/{slug}?{qs}",timeout=60) as r: w=json.load(r)
    except Exception as e:
        print(fid,"FAIL",e); continue
    provs=[dict(p,values=bridge(p["values"])) for p in w["providers"]]
    provs=[p for p in provs if p["values"]]
    w["providers"]=provs
    json.dump(w,open(f"lab/fixtures/{fid}.json","w"))
    index.append({"id":fid,"slug":slug,"filters":flt,"why":why,"providers":len(provs),"points":len(w["timestamps"]),"unit":w["unit"]})
    print(fid,slug,w["unit"],len(provs),"providers",len(w["timestamps"]),"pts")
json.dump(index,open("lab/fixtures/index.json","w"),indent=1)
