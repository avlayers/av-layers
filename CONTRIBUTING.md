# Contributing

av-layers is licensed under [AGPL-3.0-only](LICENSE). Contributions are accepted
under the [Contributor License Agreement](CLA.md), which lets the maintainer
offer the project under other licences as well. Opening a pull request means you
accept it.

## Setup

Use the Node and pnpm versions pinned in [package.json](package.json).

| You are working on | You need | Commands |
|---|---|---|
| Map, Windgram, client packages | Node, pnpm | `pnpm install`, `pnpm tools:pmtiles`, `pnpm dev` |
| API Worker | the above | `pnpm test:integration` runs local workerd |
| Batch builds, masks, terrain | the above plus `uv` (Python 3.12) | see [development](docs/development.md) |

## Before you open a pull request

- Run `pnpm verify` (lint, knip, typecheck, reference check, builds, all tests).
- Keep one concern per pull request and write a title that says what changed.
- Say whether the change alters forecast values and, if so, which method version
  it bumps (see [science](docs/science.md)).
- New infrastructure (caching, HTTP, queues, storage access, map drawing) needs a
  [decision record](docs/decisions/README.md) naming the library or platform feature it
  was weighed against.
