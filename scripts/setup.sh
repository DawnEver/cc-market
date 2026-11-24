#!/usr/bin/env bash
# cc-market setup: publish release tags with every push.
set -e

if [ ! -d scripts/git-hooks ]; then
  echo "Error: run this from the cc-market repo root" >&2
  exit 1
fi

# The git hooks are the family's (pyproject.toml [tool.dev_lab.hooks]; install: AGENTS.md "Family flow").

# Explicit releases create a local tag; publish it with the following ordinary push.
if [ "$(git config --get push.followTags || true)" != "true" ]; then
  git config push.followTags true
  echo "cc-market: push.followTags enabled (tags now ship with git push)"
fi
