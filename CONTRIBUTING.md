# Contributing to Bitcrane

Thanks for looking into the code. This file describes how the project is laid out and the rules
every change follows, whoever writes it. Parts of Bitcrane are written with the help of an AI
assistant; the same rules apply to that code, and it is reviewed against them like any other.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | User interface: React and TypeScript, built with Vite |
| `src/state/` | Application state and user actions: `store.ts` gathers `core.ts` and one module per feature; `live.ts` gathers the modules in `state/live/` that drive the real backend |
| `src/backend/` | The interface between UI and core: `tauriBackend.ts` talks to Rust, `mockFs.ts` backs the browser demo |
| `src/components/` | React components; dialogs in `src/components/dialogs/` |
| `src/styles/` | Design tokens (`tokens.css`) and component styles |
| `src-tauri/src/` | Rust core: one module per protocol or service, plus watching, sync, keys, CLI |
| `src-tauri/src/commands/` | The Tauri commands the interface calls, one module per area; `lib.rs` keeps the app state and the start |
| `website/` | bitcrane.de, plain HTML/CSS/JS, built by `website/build.py` |
| `docs/` | User documentation linked from the README |

## Commands

```sh
npm ci                  # install
npm run dev             # browser demo of the UI with invented servers and files
npm run tauri dev       # the real app
npm run format          # Prettier (interface); `npm run format:check` only reports
npm run lint            # ESLint, fails on any warning
npm run build           # type check and production build of the UI
cd src-tauri && cargo fmt && cargo test --lib && cargo clippy --all-targets -- -D warnings
python3 website/build.py https://dev.bitcrane.de   # test build of the website
```

Before a change is merged, formatting, lint, type check, tests and Clippy pass without errors or
warnings. The workflow `.github/workflows/checks.yml` runs them on every push to `main` and to
`native-check` (Clippy on Windows, where the platform code is compiled); push to `native-check`
first to check a change before it reaches `main`. A warning is fixed, not silenced: a
suppression (`eslint-disable`, `#[allow]`) needs a reason next to it.

Formatting is not discussed in review: Prettier and rustfmt decide it (120 columns, see
`.prettierrc.json` and `src-tauri/rustfmt.toml`).

## Code rules

1. **Guard at the boundaries, trust the inside.** Input from users, the network, files, the
   operating system and the browser is checked where it enters. Code that only our own code calls
   is not defended against itself: no "if this is missing, quietly return" for things that cannot
   be missing. A real bug should fail loudly where it happens, not disappear.
2. **Define once, use everywhere.** A helper, a colour, a text, a number with a meaning lives in
   one place and is referenced from there. If something is needed a second time, move it to a
   shared place instead of copying it.
3. **Support what is listed, nothing older.** Supported systems: macOS 11 and later, Windows 10
   and 11; for the website Safari 16.4 and later and current Chrome, Edge and Firefox. No
   workarounds for anything older.
4. **One area per file.** When a file starts to mix areas (a dialog with its own data model, a
   store module that also drives the backend), split it before adding more.
5. **No dead code.** No commented-out code, unused exports, leftovers of earlier variants or
   options "for later". Version control remembers the past.
6. **Comments explain why, not what.** Professional English, written for the next developer.
   Names should make the "what" obvious.
7. **Both platforms, both themes, both languages.** Every visible change is checked on macOS and
   Windows, in light and dark, in German and English. German texts are the keys in `src/i18n.ts`,
   English is in `src/i18n.en.ts`, further languages in `src/locales/` (missing texts fall back to
   English).
8. **Invented data only.** Screenshots, demo data, tests and examples use made-up names,
   servers and files, never real personal data.
9. **No emojis in the interface.**
10. **Secrets never go into the repository.** Keys and passwords live in the system keychain or in
   local files that are ignored by git.

## Refactoring

Many small changes over weeks leave duplicates and leftovers behind, however careful each one is.
After a larger feature or a series of changes, the affected area gets a refactoring round: remove
duplicates and dead code, align it with the rules above, and verify that nothing visible changed
(screenshots before and after for UI work). Larger changes and every refactoring round are read
by a second reviewer who has not seen them being written.

## Commits

Short English subject line saying what changed; a body when the reason is not obvious.
Release notes are written in English.

## License

By contributing you agree that your contribution is licensed under the GNU GPL v3, like the rest
of Bitcrane (see `LICENSE`).
