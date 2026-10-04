# Recall

A fast desktop SQL client for **PostgreSQL** and **MySQL**.

Built on [Electrobun 2.0.2](https://blackboard.sh/electrobun/): a **Bun main process** (`src/bun/`) talks to databases and the OS, and a **Vue 3 + Pinia renderer** (`src/mainview/`) renders the UI in the system webview. Everything is driven by the [`hutch`](https://github.com/blackboardsh/hutch) CLI — there is no `npm install`, no `pnpm`, no Makefile.

> **Status: no released build yet.** There is no GitHub Release, no signed installer, and no CI. The only supported way to get Recall is to build it from source (below).

## Features

- **Connection manager** — profiles for PostgreSQL and MySQL, stored in a local SQLite database; passwords go to the OS keychain, never to the database file or an RPC payload.
- **Schema browser** — databases, schemas, tables, columns, foreign keys, triggers, indexes, per database.
- **SQL editor** — CodeMirror 6 with dialect-aware highlighting, autocomplete, statement outlining, per-statement error reporting, and autosave.
- **Smart run** — `Mod-Enter` runs, in order of narrowing: the run in flight → the selection → the statement under the caret → the whole document.
- **Result grid** — virtualized, sortable, filterable, resizable and reorderable columns, pinned row headers, cell selection with keyboard navigation, CSV export.
- **SQL file management** — open folders of `.sql` files in the sidebar with rename, cut/copy/paste, delete, and optimistic-concurrency saves that refuse to clobber.
- **Tabs & snippets** — persistent tab state and reusable SQL snippets.
- **Mnemonic bookmarks** — `Mod+Shift+<key>` to jump, `Mod+F11` then a key to set one.
- **Quick open** — `Mod+P` fuzzy palette across files, connections, and bookmarks.
- **Theming** — light/dark, resizable panels, native macOS menu.

## Requirements

| | |
| --- | --- |
| OS | macOS (primary), Linux, Windows |
| Toolchain | [`hutch`](https://github.com/blackboardsh/hutch) — version pinned by the `// @hutch` pragma in `hutch.config.ts` |

`hutch` manages Bun, Cottontail, Electrobun, and the devkit for you. You do not install them yourself.

Install `hutch` once, globally:

```sh
# macOS / Linux
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh

# Windows PowerShell
& ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))

hutch --version
```

## Get the source

```sh
git clone git@github.com:prometheusalpha/recall.git
cd recall
hutch run install
```

`hutch run install` resolves `package.json` against `hutch.lock` and prepares the devkit into `.hutch/` (gitignored). **Run it before anything else on a fresh clone** — `tsconfig.json` and `vite.config.ts` both extend from the generated `.hutch/devkit`, so typecheck and bundling break without it.

## Develop

```sh
hutch run dev
```

That builds the renderer with Vite, then opens the app window. Edit a file and the app rebuilds.

With hot module replacement for UI-only work:

```sh
hutch run dev:hmr
```

Runs Vite on `http://localhost:5173` alongside the app, concurrently. Port 5173 is `strictPort` — free it first or the task fails.

| Command | What it does |
| --- | --- |
| `hutch run dev` | Build renderer + launch app, rebuild on change |
| `hutch run dev:hmr` | Vite HMR on `:5173` + app |
| `hutch run hmr` | Vite dev server only |
| `hutch run build` | Production build (`--env=stable`) |
| `hutch run typecheck` | `vue-tsc --noEmit` — **the only automated quality gate** |
| `hutch pm exec -- vite build` | Renderer-only build into `dist/` |

`bun run <script>` works as an alias for `hutch run <script>`; both come from `hutch.config.ts`.

### Build a local app

```sh
hutch run build                              # → build/stable-macos-arm64/recall.app
bun run build:mac                            # build + install into ~/Applications
```

`hutch.config.ts` also defines `build:canary` — a separate prerelease channel.

## Architecture

```
src/shared/    type-only domain types + the RPC contract (no runtime code)
src/bun/       main process: RPC handlers, connection pool, dialect drivers,
               app SQLite db, OS keychain, filesystem, app menu
src/mainview/  renderer: Pinia stores, composables, lib helpers, .vue components
```

The renderer never touches a database. Every call crosses one typed RPC proxy declared in `src/shared/rpc.ts`, bound to handlers in `src/bun/handlers.ts`. Dialect knowledge lives entirely in the `Driver` interface (`src/bun/driver.ts`) and its two implementations in `src/bun/drivers/`.

State lives in three places, deliberately:

- **SQLite `recall.db`** — connection profiles and bookmarks
- **OS keychain** — passwords only
- **localStorage** — tabs, snippets, theme, panel sizes, SQL file folders and bindings

Full architecture rules, invariants, and conventions live in [`GUIDELINE.md`](GUIDELINE.md). The roadmap lives in [`TODO.md`](TODO.md).

## Testing

There is no test suite, no test framework, and no CI. `hutch run typecheck` is the only automated gate — run it before opening a PR. Beyond that, verify by running the app: connect → introspect → run SQL → cancel, open a SQL folder → edit → save (conflict path), and bookmark jump after editing a file.

## License

Not yet declared.