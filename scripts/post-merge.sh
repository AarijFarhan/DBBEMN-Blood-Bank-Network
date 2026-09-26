#!/bin/sh
set -eu
pnpm install --frozen-lockfile
pnpm run migrate
