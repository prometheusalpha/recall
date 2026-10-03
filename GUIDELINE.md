# Repository Guidelines

## Project Overview

**Recall** — a fast desktop SQL client for **PostgreSQL and MySQL**. Built on
**Electrobun 2.0.2**: a **Bun main process** (`src/bun/`) that talks to databases
and the OS, and a **Vue 3 + Pinia renderer** (`src/mainview/`) running in WebKit.
Everything is driven by the `hutch` CLI (`hutch.config.ts`), not npm/pnpm/yarn.

## Architecture & Data Flow

Three source roots, one contract between them:

```
src/shared/   type-only domain types + the RPC contract (no runtime code)
src/bun/      main process: RPC handlers, connection pool, dialect drivers,
              SQLite app db, OS keychain, filesystem, app menu
src/mainview/ renderer: Pinia stores, composables, lib helpers, .vue components
```

The renderer never talks to a database. Every call goes through **one typed RPC
proxy** declared in `src/shared/rpc.ts`:

- `src/mainview/lib/rpc.ts` — **the only renderer file importing `electrobun`**
  (`electrobun/view`). Builds `rpc` via `Electroview.defineRPC<AppRPC>` and calls
  `new Electroview({rpc})` to install the transport.
- `src/bun/rpc.ts` — **the only main-process file binding handlers to the
  transport**. Merges transport-free handlers with the two native ones
  (`pickFolder`, `revealInFolder`) and wires the one-way push channels.
- `src/bun/handlers.ts` — transport-free request handlers, type-checked against
  the full `BunRequests` surface by a mapped `satisfies` type.

**Example flow — running a SQL batch:**

1. `src/mainview/components/workspace/SqlEditor.vue` → `queryStore.run(tabId)`
2. `src/mainview/stores/query.ts` → `ensureConnected()`, then
   `rpc.request.execute({connectionId, database, schema, sql, executionId, maxRows})`
3. `src/bun/handlers.ts` → `handlers.execute` → `splitStatements(sql, config.dbType)`
4. `src/bun/connectionPool.ts` → `getConnection()` (reuses the pooled `Bun.SQL` handle)
5. `src/bun/driver.ts` → `driverFor(dbType)` → `src/bun/drivers/{postgres,mysql}.ts`
6. Per statement, `handlers.runStatement` emits `queryProgress` per statement and
   collects `StatementResult`s (errors included as data)
7. `StatementResult[]` returns to the store → `ResultGrid.vue` renders rows or the
   inline error cell.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/shared/` | `rpc.ts` (`BunRequests`/`AppRPC`), `types.ts`, `bookmark.ts`, `sqlFile.ts` |
| `src/bun/drivers/` | `postgres.ts`, `mysql.ts` — **the only** files allowed to know a dialect |
| `src/bun/` | `handlers.ts`, `rpc.ts`, `connectionPool.ts`, `driver.ts`, `appDb.ts`, `connectionStore.ts`, `bookmarkStore.ts`, `credentialStore.ts`, `sqlFiles.ts`, `menu.ts`, `index.ts` |
| `src/mainview/stores/` | 6 Pinia setup stores: `connections`, `tabs`, `query`, `sqlFiles`, `bookmarks`, `snippets` |
| `src/mainview/composables/` | `useQuickOpen`, `useGridSelection`, `useToast`, `useTheme`, `usePanelResize`, `useFlatTree` |
| `src/mainview/lib/` | `rpc.ts` (proxy), `sqlSplit.ts`, `sqlDialect.ts`, `fuzzy.ts`, `cn.ts`, `fileDatasource.ts`, `connectionDefaults.ts` |
| `src/mainview/components/` | `layout/`, `workspace/`, `sidebar/`, `files/`, `dialogs/`, `quickopen/`, `editor/`, `ui/` (shadcn-vue primitives) |

State lives in **three** places, deliberately:
- **SQLite** `recall.db` — connection profiles + bookmarks (`src/bun/appDb.ts`).
- **OS keychain** — passwords only (`src/bun/credentialStore.ts`).
- **localStorage** — `recall.tabs`, `recall.snippets`, `recall.sqlFileFolders`,
  `recall.sqlFileFilter`, `recall.sqlFileBindings`, `recall.theme`,
  `recall.resultPaneSize`, `recall.panel.sidebar`, `recall.panel.files`,
  `recall.connections` (legacy, read-once-then-delete).

## Development Commands

All commands go through `hutch`. There is no `npm install`, no Makefile.

```sh
hutch install --frozen-lockfile   # install deps (hutch.config.ts scripts.install)
hutch run dev                     # or: bun run dev  — build renderer + open app
hutch run dev:hmr                 # vite HMR on :5173 + app, concurrently
hutch run build                   # production build (--env=stable)
hutch run typecheck               # vue-tsc --noEmit — THE ONLY quality gate
hutch pm exec -- vite build       # renderer-only build, output to dist/
```

`hutch run build:canary` exists in `hutch.config.ts` only, not in `package.json`.

## Runtime/Tooling Preferences

- **Bun 1.4.0** (`.hutch/devkit/api/shared/bun-version.ts`), **Cottontail 0.7.1**,
  **Electrobun 2.0.2**, **hutch CLI 0.27.1** (pinned in `hutch.config.ts:1`).
  Never introduce npm/pnpm/yarn scripts — they bypass the toolchain.
- **TypeScript strict** (`strict`, `noUnusedLocals`, `noUnusedParameters`,
  `isolatedModules`, `noEmit`). Unused locals and params are build errors.
- **Path aliases**: `@/` → `src/mainview/`, `@shared/` → `src/shared/`,
  `electrobun/*` → generated stubs.
- **Port 5173 with `strictPort: true`** must be free or `dev` fails.
- **No linter, no formatter that works.** `bun run format` invokes `oxfmt`, which
  is in no manifest and no lockfile — it will not resolve. Match surrounding
  style by hand instead: **tabs, double quotes, trailing commas, `import type`
  for type-only imports.**
- **`.hutch/` is gitignored** but `tsconfig.json` extends
  `./.hutch/devkit/tsconfig.json` and `vite.config.ts` imports from it. Run
  `hutch electrobun prepare` before typechecking on a fresh clone, or both break.
- Never commit credentials. There is no env-var credential path and no
  `.env.example`.

## Code Conventions & Common Patterns

**Architectural invariants — read the TSDoc header before editing any file.**

1. **Renderer must not import `electrobun/main`.** `grep 'from "electrobun"' src/`
   should return exactly 6 files: `src/bun/{index,menu,rpc,appDb}.ts`,
   `src/mainview/lib/rpc.ts`, and a type-only import in `src/shared/rpc.ts`.
2. **`src/bun/handlers.ts` carries no Electrobun import.** The native FFI library
   only exists inside the packaged app, so an Electrobun import there makes every
   driver call reachable only from the GUI. Same for `driver.ts`, `drivers/*`,
   `connectionPool.ts`, `credentialStore.ts`, `connectionStore.ts`,
   `bookmarkStore.ts`, `sqlFiles.ts`. (`appDb.ts` is the one documented carve-out
   — it imports `Utils.paths.appData`.)
3. **All dialect knowledge lives in the `Driver` interface** (`src/bun/driver.ts`).
   No other module may branch on `dbType` or spell out `information_schema`.
   Add a `Driver` member instead.
4. **`src/mainview/lib/sqlSplit.ts` mirrors `splitStatements` in
   `src/bun/driver.ts`** and the two must stay byte-for-byte compatible in their
   scanning rules. Change both in the same commit. Same rule for
   `lib/connectionDefaults.ts:readUrlParam` ↔ `driver.ts:parseUrlParams`.
5. **Passwords never reach SQLite or an RPC payload.** `ConnectionProfile` has no
   password, the `connections` table has no password column, `listConnections()`
   hardcodes `password: ""`. Secrets live in the keychain and are refilled by Bun
   on `connect`.
6. **Errors are data, not exceptions.** `StatementResult.error`, `BackendError`,
   `SqlFileWriteResult`, `SnippetWriteResult`, `CloseResult`, `ConnectionTestResult`.
   `runStatement` never throws for a database error. Only transport/store-level
   failures throw, and `lib/rpc.ts:errorMessage` normalises them.
7. **Everything crossing RPC must survive JSON.** `driver.ts:toJsonSafe` converts
   BigInt → string, Date → ISO, Uint8Array → base64, null/undefined → null.
8. **Progress is a push, not a poll.** `bun.messages` is intentionally empty; only
   `webview.messages` (`queryProgress`, `connectionLost`) carries pushes. The
   handlers emit through injected callbacks (`setProgressEmitter`) so they stay
   transport-free.
9. **Optimistic concurrency, never a silent clobber.** `writeSqlFile` takes
   `expectedVersion` and refuses on mismatch; versions are re-earned by reading,
   never persisted across sessions.
10. **Path safety is one function**: `sqlFiles.ts:realpathInside`. Don't add
    parallel checks; `handlers.exportResult` handles the filename half.
11. **localStorage blobs are user-writable** — validate field by field
    (`isTab`, `isStoredConfig`, `isDatasource`) and degrade to a default rather
    than throwing.
12. **Module singletons only where there's no provider** (`useToast`,
    `useQuickOpen`). Never call `useStore()` at module scope in a file imported
    before `createApp().use(createPinia())` runs.

**Naming.** Stores: `defineStore("<singular-noun>", setupFn)` in a file of the
same name, exported as `use<Name>Store`. Composables: `useX`, one per file. Vue
components: PascalCase; `components/ui/<primitive>/` follows shadcn-vue with an
`index.ts` barrel. Types: PascalCase, discriminated unions on `ok`/`reason`/`kind`.
Backend functions: verbs — `list*`, `read*`, `write*`, `save*`, `clear*`,
`resolve*`, `open*`, `close*`, `forget*`, `to*`, `parse*`, `normalize*`.
Constants: `SCREAMING_SNAKE`.

**Postgres vs MySQL — never assume they behave alike.** The largest differences:
`driver.databaseScoped` is `true` for Postgres (a session is pinned to one
database; a request naming another opens its own) and `false` for MySQL (one
session serves every database). Postgres has a schema layer; MySQL does not and
`listSchemas` returns `[]`. Placeholders are `$1..$n` vs `?`. Identifier quoting
is `"x"` vs `` `x` ``. Postgres has dollar-quoting and no backslash escapes; MySQL
has `#` comments and backslash escapes. `uniqueness` is `indisunique` vs an
inverted `non_unique`. If you touch `drivers/`, both files must stay symmetric.

## Important Files

| File | Role |
| --- | --- |
| `hutch.config.ts` | Toolchain pin + every `hutch run <task>` target |
| `package.json` | Dependency set; scripts are hutch wrappers |
| `electrobun.config.ts` | App identity, `cottontail.entrypoint: src/bun/index.ts`, Vite→`views/mainview/` copy map. **`capabilities: ["sql"]` is load-bearing** — removing it makes the packaged app throw `Cottontail capability "sql" is unavailable` on first connect |
| `vite.config.ts` | `root: src/mainview`, `outDir: ../../dist`, port 5173, aliases |
| `tsconfig.json` | Strict flags; extends the generated `.hutch/devkit/tsconfig.json` |
| `components.json` | shadcn-vue config — governs how UI primitives are added |
| `src/shared/rpc.ts` | **The API surface.** Change this first when adding a method |
| `src/bun/rpc.ts` | Transport binding + native handlers |
| `src/bun/driver.ts` | `Driver` interface, `splitStatements`, `toJsonSafe`, `normalizeBackendError` |
| `src/mainview/lib/rpc.ts` | The single renderer↔Bun proxy; `RPC_TIMEOUTS` |
| `TODO.md` | The only project-authored Markdown (Vietnamese bug/feature roadmap) |

There is **no README, CONTRIBUTING, LICENSE, CHANGELOG, `.github/`, CI, or
`docs/`**. The header comments on ~40 source files are the documentation — read
them; they record post-mortems of bugs that are easy to reintroduce.

## Testing & QA

**There is no test suite, no test framework, and no CI.** `package.json` has no
`test` script and no test dependency; `bun.lock` resolves no runner. The only
`*.test.ts` files in the tree are inside the gitignored vendored devkit
(`.hutch/devkit/**`) and belong to upstream Electrobun, not this project.

Consequences:

- **`bun run typecheck` is the only automated gate. Run it before you finish.**
- Do not assume a test can be written for a change; if you add a runner, that is
  a deliberate decision, not an incidental dependency.
- Verify by **running the app**: `hutch run dev`. The flows most likely to break
  from a code change are connect → introspect → run SQL → cancel, open a SQL
  folder → edit → save (conflict path), and bookmark jump after editing a file.
- Vendored Electrobun tests use `bun:test` (`describe`/`test`, `expect`). That's
  the house style if tests are ever added.