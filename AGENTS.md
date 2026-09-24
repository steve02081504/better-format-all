# AGENTS.md — better-format-all VS Code extension

`betterFormatAll.formatFolder`（资源管理器文件夹右键）会把目标文件夹下所有「被 git 跟踪且自上次格式化后发生改动」的文件、以及所有「未跟踪且未被忽略」的文件，逐个用编辑器默认格式化器处理一遍。

## 命令

```powershell
npm install   # once
npm test      # @vscode/test-cli，复用 PATH 上本机安装的 VS Code（不下载）
npm run build # 打包 VSIX 并用本机 `code` 安装
npm run package # 只打包，不安装
eslint --fix --quiet # 共享风格规则；项目 eslint.config.mjs 已忽略 .vscode-test 等生成目录
```

- `eslint.config.mjs` 复用公共配置（`my-eslint-config/deno.mjs`）并追加 `ignores`。否则 ESLint 会向上找到家目录的配置，把 `.vscode-test/user-data/**` 里 VS Code 自带的 `askpass-main.js` 也当成源码报一堆 JSDoc 错误。该风格要求单语句不加花括号，`eslint --fix` 会自动改。
- 必须直接运行 `eslint`（Deno 安装的二进制），**不要用 `npx eslint`**：公共配置 `import` 的是 https URL，Node 的默认加载器不支持，只有 Deno 能解析。同理该配置面向 Deno，代码里不要用 `Buffer` 等 Node-only 全局（会触发 `no-undef`），二进制处理用 `Uint8Array`。

## 结构

- `extension.mjs`：注册命令、遍历目标目录、报告进度/结果、写回基线。多选时 VS Code 传入 `(resource, selected)`，两者都处理。先 `planTarget` 规划出所有目标的文件总数，再用 `progress.report({ increment })` 显示确定进度条；未预期异常由 `handleError` 写入输出通道并 `showErrorMessage`，每个文件失败也会自动展示输出通道。
- `lib/git.mjs`：`git` 包装。所有列举都返回相对仓库根、以 `/` 分隔的路径。
- `lib/state.mjs`：`.git` 下 JSON 的读写、基线解析、记录更新。
- `lib/planner.mjs`：按基线分组算出待格式化文件；前 8 KiB 内含 NUL 字节的文件视为二进制并忽略。
- `lib/formatRunner.mjs`：打开 → `editor.action.formatDocument` → 保存 → 关闭。

## 基线模型（核心不变式）

- 记录文件默认 `.git/better-format-all.json`，`subpaths` 是「相对仓库根的路径 → commit SHA」，仓库根用空串 `''`。
- 某个文件用**自身目录或最深层祖先**的条目作基线（`state.mjs#resolveBaseline`）。这样单独格式化过的子目录下次在父目录任务里不会再被算一遍。
- 某路径完整格式化后写回该路径（`state.mjs#recordFormatted`）会**清掉它内部所有更细的旧条目**——父条目已经覆盖它们，留着只会多算改动。
- 基线 commit 用 `refs/better-format-all/<sha>` 这一 ref 命名空间**钉住**（写回记录后 `git.mjs#syncBaselineRefs` 同步、规划时 `pinRevision` 即时钉住）：amend/rebase/filter-branch 后基线会成为不可达对象，不钉住就会被 `git gc` 回收，下次规划就只剩「整组重算」这一条路。规划时若基线已缺失，还会按 SHA 从各远端取回（`git.mjs#fetchRevision`，GitHub 允许取未在 ref 上广告的对象），取回后立即钉住。这些 ref 不显示为分支/标签，但会出现在 `git log --all` 里。
- 基线的写回是**每个目标目录**跑完后的最后一步：只有该目录既未取消、也没有文件失败时才写；失败计数是**每个目标各自**的，别的目录失败不影响本目录写回。`sha` 取不到（仓库尚无提交）时不写。中途取消/关闭窗口不会留下半截基线，旧基线保留，未处理完的文件下次仍会被 `git diff <旧基线>` 或未跟踪状态重新纳入，不会遗漏。
- 目标不在 git 仓库内时用 `showErrorMessage` 报错并跳过，不做任何事。
- 选择规则：无基线 ⇒ 该组全部被跟踪文件；有基线 ⇒ 「工作区相对基线内容」的改动与「工作区相对 `merge-base(基线, HEAD)`」的改动**取交集**。两个端点用工作区而非 HEAD 是刻意的：未提交的修改每次都重新处理。交集的两个维度各自解决一个坑：基线 commit 的树精确反映内容是否变化，能扛住「只改老 commit 的 message」这种祖先链 SHA 全变的元数据重写（否则合并基点会一路退到被改 commit 的父提交，把之后所有改动重算）；合并基点则把范围钉在当前这条历史自身，扛住基线位于另一条分叉（切分支/异源 clone）时 `git diff <基线>` 把那条分叉独有改动也算进来导致整仓重排。`merge-base` 取不到（无共同祖先）时只按基线内容比较；基线对象缺失且从远端也取不回时整组重算，绝不漏。未跟踪非忽略文件永远纳入（`--exclude-standard`）。开头 8 KiB 含 NUL 的二进制文件在规划阶段就被排除，不计数也不处理。

## 默认格式化器

- 用 `editor.action.formatDocument`（等同“格式化文档”），让它按 `editor.defaultFormatter` 走；**不要**自己挑 provider，也不要替它选第一个（未配置时的行为交给 VS Code）。
- 该命令作用于活动编辑器，所以先 `showTextDocument`；处理完按 URI 精确关掉自己开的标签页。原本已打开且未保存的文件跳过，不碰用户未保存的改动。

## 本地化与 README

- 支持 `en`/`en-US`、`en-gb`、`zh-cn`、`ja`、`fr`、`es`、`hi`。UI 字符串一律走 `vscode.l10n.t('English source')`，翻译放 `l10n/bundle.l10n.<locale>.json`，键必须与源码字符串逐字一致；命令/配置标题走 `package.nls.<locale>.json`。
- README 每种语言一份（`README.md` 为英文主入口，`README.<locale>.md` 为翻译），每份顶部有互相链接的语言导航，当前语言加粗。

## Windows 上的坑

- **目标目录的相对路径必须用 `git rev-parse --show-prefix` 算**，不要用 `path.relative(repoRoot, target)`：本机 `%TEMP%` 是 8.3 短路径（`C:\Users\STEVE0~1\...`），`git rev-parse --show-toplevel` 却返回长路径，两者混用会算出 `../../..` 导致 `git` 报 “outside repository”。
- git 会把 `.git/objects` 下的对象设为只读，`fs.rmSync(..., { force: true })` 在它们上抛 EPERM。测试清理见 `test/helpers.mjs#removeDir`：递归 `chmod` 去只读 + 重试；VS Code 关闭编辑器后可能仍短暂持有句柄，所以最后一次失败被吞掉，清理不应让测试失败。
- 测试里创建仓库后要提交的文件用 `git add -A`，因此**未跟踪文件必须在提交之后再创建**，否则会变成被跟踪的。
- 路径列举带 `:(literal)` pathspec，避免文件名里的 `*`/`?` 被当通配符。

## 测试

- `test/**/*.test.mjs` 跑在 VS Code 扩展宿主里（mocha 全局 `suite`/`test`）。`.vscode-test.mjs` 通过 `@steve02081504/exec#where_command('code')` 找本机 VS Code，跨盘时用 junction 搭桥，**绝不下载**。
- mocha 超时统一设为 60s（`.vscode-test.mjs` 的 `mocha.timeout`）：集成测试要开关编辑器，堆积的机器上会超过默认 2s。
- `test/extension.test.mjs` 用一个仅本测试可见的 plaintext 格式化器（大写整篇）验证端到端：改动/未跟踪文件被格式化、忽略文件不动、基线写入 `.git/better-format-all.json`、打开过的标签页全部关闭。

## 上游/环境说明

- 打包会警告缺少 `repository` 与 `LICENSE` 字段；仓库地址未知时不要瞎填。
- `@vscode/vsce-sign` 的 postinstall 可能被 npm 的 install-scripts 策略拦截，只会影响 VSIX 签名，不影响未签名打包。
