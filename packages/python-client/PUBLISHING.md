# Publishing `openchainbench` to PyPI

Releases are fully automated through GitHub Actions and PyPI Trusted
Publishers. No long-lived API token is stored anywhere.

## One-time setup (PyPI Trusted Publisher)

1. Create an account on https://pypi.org if you do not have one.
2. Reserve the project name by uploading the first release manually
   **or** request the project via the PyPI account settings. We do the
   pending publisher flow below so the very first release is automated.
3. Go to https://pypi.org/manage/account/publishing/ and click
   **Add a new pending publisher**.
4. Fill in:
   - PyPI project name: `openchainbench`
   - Owner: `ChainBench`
   - Repository name: `OpenChainBench`
   - Workflow name: `pypi-publish.yml`
   - Environment name: `pypi`
5. Save. PyPI will accept the first upload from the matching GitHub
   workflow with no token.
6. In GitHub, go to **Settings > Environments** for the repo and create
   the `pypi` environment. Add required reviewers if you want a manual
   gate before publish.

## Cutting a release

1. Bump the version in two places:
   - `packages/python-client/pyproject.toml` (`project.version`)
   - `packages/python-client/src/openchainbench/__init__.py` (`__version__`)
   - `packages/python-client/src/openchainbench/client.py` (`USER_AGENT`)
2. Commit the bump on `main`.
3. Tag and push:
   ```bash
   git tag python-v0.1.0
   git push origin python-v0.1.0
   ```
4. The `PyPI Publish` workflow runs: build, smoke test on 3.10-3.13,
   then publish via the Trusted Publisher OIDC flow.
5. Verify the release at https://pypi.org/project/openchainbench/.

## Local smoke build

```bash
cd packages/python-client
python -m pip install --upgrade build
python -m build
ls dist/
```

This produces an `sdist` (`.tar.gz`) and a pure-Python `wheel` (`.whl`).
The Trusted Publisher workflow runs the exact same command in CI.

## Tag namespace

We deliberately use `python-v*` (not bare `v*`) so OCB site tags such as
`v1.0-dataset` never trigger a Python publish.
