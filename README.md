# better-format-all

**English** · [简体中文](README.zh-cn.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [हिंदी](README.hi.md)

Format every git-tracked or uncommitted file under a folder with its default formatter, straight from the Explorer context menu.

## Features

- **Format a whole folder** — right-click any folder in the Explorer and choose **Better Format All Files in Folder**.
- **Only what changed** — the first run formats every tracked file; later runs format only the files that changed since the last fully formatted commit, plus every untracked file that git does not ignore. Uncommitted changes are always picked up.
- **Minimal work per sub-path** — the last fully formatted commit is remembered per sub-path in `.git/better-format-all.json`, so a sub-folder formatted on its own is not redone when you later format its parent.
- **The default formatter** — files are formatted through _Format Document_, so the configured `editor.defaultFormatter` is used. The extension never silently picks the first available formatter for you.
- **Safe to cancel** — a progress notification lets you cancel. A cancelled or partially failed run does **not** update the baseline, so the next run still sees every unformatted file.
- **Localized UI** — follows the VS Code display language.

## Usage

1. In the Explorer, right-click a folder inside a git repository.
2. Choose **Better Format All Files in Folder**.
3. Each file is opened, formatted with its default formatter, saved and closed again.

Right-clicking a folder that is not inside a git repository reports an error and does nothing.

## How the baseline works

- The state lives in `.git/better-format-all.json` (configurable with `betterFormatAll.stateFile`). It maps a repository-relative path to the commit SHA at which that path was last fully formatted; the repository root is the empty string `''`.
- A file uses the **deepest recorded ancestor or itself** as its baseline. When a path is fully formatted, more specific entries below it are removed — the parent entry already covers them.
- With no baseline, every tracked file under the target is formatted. With a baseline, the selection is `git diff <sha>` **against the working tree** (so uncommitted edits count) plus untracked, non-ignored files.
- The baseline is written only after the target finished completely (nothing cancelled, no failure).

## Settings

| Setting                            | Default                  | Description                                                  |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `betterFormatAll.stateFile`        | `better-format-all.json` | File name written inside the repository's `.git` directory.  |
| `betterFormatAll.includeUntracked` | `true`                   | Also format files that are untracked and not ignored by git. |

## Requirements

- Visual Studio Code 1.100.0 or newer.
- `git` on `PATH`.
- A default formatter configured for the languages you want to format (`editor.defaultFormatter`); files whose language has no formatter are left unchanged.

## Localization

| Language                 | Locale        |
| ------------------------ | ------------- |
| English (United States)  | `en`, `en-US` |
| English (United Kingdom) | `en-gb`       |
| 简体中文                 | `zh-cn`       |
| 日本語                   | `ja`          |
| Français                 | `fr`          |
| Español                  | `es`          |
| हिंदी                    | `hi`          |

Command titles and notifications follow the VS Code display language.

## Development

```powershell
npm install   # once
npm test      # run the test suite against the local VS Code
npm run build # package the extension and install it locally
```

See `AGENTS.md` for maintainer notes.

## License

[LGPL-3.0-only](LICENSE.md)
