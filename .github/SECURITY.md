# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/OpenChainBench/OpenChainBench/security/advisories/new) on this repository. Do **not** open a public issue for a security report — the advisory mechanism keeps the disclosure private until a fix is in place.

If GitHub is not an option, email **security@openchainbench.xyz** with:

- A description of the vulnerability and the affected component (site, harness, infrastructure).
- A reproducer or proof of concept.
- Your contact details for follow-up (email is fine).

We aim to acknowledge reports within 72 hours and provide a remediation timeline within 7 days.

## Scope

In-scope:

- The Next.js site (`src/`).
- The published harnesses (`harnesses/`).
- The Prometheus / Grafana / Alertmanager configurations under `harnesses/<bench>/deploy/`.
- The benchmark specs (`benchmarks/*.yml`) — particularly any spec that could exfiltrate secrets through a malformed Prometheus URL.

Out-of-scope:

- Provider-side vulnerabilities (we benchmark these services; we don't operate them). Report those to the provider directly.
- Issues in third-party dependencies that have already been disclosed upstream.
- Self-XSS, missing security headers without an exploit chain, and similar low-severity findings unless tied to a concrete impact.

## What gets a CVE

We assign CVEs (via GitHub) for:

- Remote code execution in the harnesses or the site.
- Authentication / authorization bypass on any deployed endpoint.
- Secret leakage from the published codebase or CI logs.
- Tampering vectors that would let an attacker influence published numbers.

## What's already disclosed

If you find a hardcoded secret in the git history (e.g. an old API key, a wallet token), please open a private advisory anyway — the secret should be rotated even if the value has been replaced in HEAD. We monitor `git log -p` for these but report them in any case.

## Preferred languages

English or French.
