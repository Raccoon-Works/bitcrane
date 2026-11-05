# Working on Bitcrane with Claude

Read `CONTRIBUTING.md` first: its layout, commands and code rules apply to every change.
This file only adds what concerns working with an AI assistant.

- **Write it like a developer from the start.** Do not cover uncertainty with defensive code.
  When it is unclear where data comes from or what is guaranteed, read the calling code or ask;
  do not add a guard "just in case". Guards belong at the boundaries (rule 1).
- **Search before writing a helper.** Check `src/util/`, `src/state/` and the existing modules
  (on the website `website/js/util.js` and `website/css/tokens.css`) for something that already
  does it, and extend that instead of adding a near copy.
- **Ask instead of assuming** when a requirement, a configuration value or the meaning of
  existing code is unclear. Never insert placeholders for values the owner has to provide.
- **Refactoring rounds** are part of the work (see `CONTRIBUTING.md`): after a feature or a
  series of changes, suggest one for the affected area, verify with screenshots before and
  after, and have an independent reviewer read the result.
- **Before every commit:** lint, type check, tests and Clippy without errors; for the website
  also `html-validate` on the built pages.
- **Private data never enters the repository.** The owner's name and address exist only in
  `website/private.json` (ignored by git); contact form addresses only in
  `website/kontakt.config.php` (ignored by git).
