import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 一次 `git diff` 可能吐出整棵仓库的路径列表，默认 1 MiB 的管道会在大型仓库上截断。
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * 运行一条 git 命令并返回其标准输出。
 *
 * @param {string[]} args - 传给 git 的参数（不含 `git` 本身）
 * @param {string} cwd - 运行目录
 * @returns {Promise<string>} 命令的标准输出
 */
export async function runGit (args, cwd) {
	const { stdout } = await execFileAsync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: MAX_BUFFER,
		windowsHide: true
	})
	return stdout
}

/**
 * 构造限定在 `rel` 下的路径参数。用 `:(literal)` 避免把文件名里的 `*`、`?` 当成通配符；仓库根传空数组。
 *
 * @param {string} rel - 相对仓库根的路径（POSIX 分隔符），空串表示整棵仓库
 * @returns {string[]} 追加到命令末尾的路径参数
 */
function pathspec (rel) {
	if (!rel) return []
	return ['--', `:(literal)${rel}`]
}

/**
 * 按 NUL 切分 `-z` 输出，丢弃结尾的空段。
 *
 * @param {string} out - git 的 `-z` 输出
 * @returns {string[]} 路径列表
 */
function splitZ (out) {
	return out.split('\0').filter((entry) => entry.length > 0)
}

/**
 * 解析包含 `cwd` 的 git 仓库根目录。
 *
 * @param {string} cwd - 任意目录
 * @returns {Promise<string | undefined>} 仓库根的绝对路径，不在仓库内时为 undefined
 */
export async function getRepoRoot (cwd) {
	try {
		const out = await runGit(['rev-parse', '--show-toplevel'], cwd)
		const root = out.trim()
		return root ? path.resolve(root) : undefined
	}
	catch {
		return undefined
	}
}

/**
 * 解析仓库的 git 目录（可能是 `worktrees/<name>` 形式）。
 *
 * @param {string} cwd - 仓库内任意目录
 * @returns {Promise<string>} git 目录的绝对路径
 */
export async function getAbsoluteGitDir (cwd) {
	const out = await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	return path.resolve(out.trim())
}

/**
 * 读取当前 HEAD 的 commit SHA。仓库尚无提交时返回 undefined。
 *
 * @param {string} cwd - 仓库内任意目录
 * @returns {Promise<string | undefined>} HEAD 的 SHA，未出生时为 undefined
 */
export async function getHeadSha (cwd) {
	try {
		const out = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
		const sha = out.trim()
		return sha || undefined
	}
	catch {
		return undefined
	}
}

/**
 * 读取 `cwd` 相对仓库根的前缀（POSIX 形式，仓库根为空串，子目录不以 `/` 结尾）。
 *
 * 用 git 自身计算而不是 `path.relative`，避免 Windows 上短路径（8.3）与 git 规范化的长路径混用，
 * 导致算出 `../../..` 这样的越界相对路径。
 *
 * @param {string} cwd - 仓库内目录
 * @returns {Promise<string>} 相对仓库根的前缀
 */
export async function getRepoPrefix (cwd) {
	const out = await runGit(['rev-parse', '--show-prefix'], cwd)
	return out.trim()
}

/**
 * 列出目录下所有被 git 跟踪的文件。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} rel - 相对仓库根的路径，空串表示整棵仓库
 * @returns {Promise<string[]>} 相对仓库根的 POSIX 路径
 */
export async function listTracked (repoRoot, rel) {
	return splitZ(await runGit(['ls-files', '-z', ...pathspec(rel)], repoRoot))
}

/**
 * 列出目录下未被跟踪、且未被 `.gitignore` 忽略的文件。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} rel - 相对仓库根的路径，空串表示整棵仓库
 * @returns {Promise<string[]>} 相对仓库根的 POSIX 路径
 */
export async function listUntracked (repoRoot, rel) {
	return splitZ(await runGit(['ls-files', '-z', '--others', '--exclude-standard', ...pathspec(rel)], repoRoot))
}

/**
 * 列出 `sha` 与工作区（含未提交改动）之间发生改动的文件，排除删除项。
 *
 * 用工作区而不是 HEAD 作右端，未提交的修改因此也会参与比较。[`--no-renames`] 把重命名拆成新增+删除，
 * 这样配合 `--diff-filter=d` 只会留下重命名后的新路径。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} sha - 基线 commit
 * @param {string} rel - 相对仓库根的路径，空串表示整棵仓库
 * @returns {Promise<string[]>} 相对仓库根的 POSIX 路径
 */
export async function listChanged (repoRoot, sha, rel) {
	return splitZ(await runGit(
		['diff', '--no-renames', '--name-only', '--diff-filter=d', '-z', sha, ...pathspec(rel)],
		repoRoot
	))
}
