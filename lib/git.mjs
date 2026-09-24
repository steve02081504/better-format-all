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
export async function runGit(args, cwd) {
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
function pathspec(rel) {
	if (!rel) return []
	return ['--', `:(literal)${rel}`]
}

/**
 * 按 NUL 切分 `-z` 输出，丢弃结尾的空段。
 *
 * @param {string} out - git 的 `-z` 输出
 * @returns {string[]} 路径列表
 */
function splitZ(out) {
	return out.split('\0').filter((entry) => entry.length > 0)
}

/**
 * 解析包含 `cwd` 的 git 仓库根目录。
 *
 * @param {string} cwd - 任意目录
 * @returns {Promise<string | undefined>} 仓库根的绝对路径，不在仓库内时为 undefined
 */
export async function getRepoRoot(cwd) {
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
export async function getAbsoluteGitDir(cwd) {
	const out = await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	return path.resolve(out.trim())
}

/**
 * 计算两个 revision 的合并基点。当基线位于另一条分叉上时，它给出二者共同的祖先；
 * 只比较当前这条历史自身的改动，就不会把另一条分叉独有的改动也算进来。
 *
 * 无共同祖先、任一 revision 取不到（rebase/GC 掉、来自别的 clone）时返回 undefined。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} a - 第一个 revision
 * @param {string} b - 第二个 revision
 * @returns {Promise<string | undefined>} 合并基点的 SHA，无法确定时为 undefined
 */
export async function getMergeBase(repoRoot, a, b) {
	try {
		const out = await runGit(['merge-base', a, b], repoRoot)
		return out.trim() || undefined
	}
	catch {
		return undefined
	}
}

/**
 * 记录基线用的 ref 命名空间。这些 ref 让基线 commit 即使经历 amend/rebase/filter-branch 也保持可达，
 * 不会被 `git gc` 当不可达对象回收。它们不显示为分支或标签，但会出现在 `git log --all` 中。
 */
const BASELINE_REF_PREFIX = 'refs/better-format-all/'

/**
 * 判断仓库里是否已能按 commit 解析出某个 revision。
 *
 * @param {string} cwd - 仓库内任意目录
 * @param {string} rev - 待检查的 revision
 * @returns {Promise<boolean>} 存在时为 true
 */
export async function objectExists(cwd, rev) {
	try {
		await runGit(['cat-file', '-e', `${rev}^{commit}`], cwd)
		return true
	}
	catch {
		return false
	}
}

/**
 * 按 SHA 从各远端取回一个本地缺失的 commit。GitHub 等允许取未在 ref 上广告的对象；
 * 某个远端没有或离线时跳过，全部失败返回 false。
 *
 * @param {string} cwd - 仓库内任意目录
 * @param {string} rev - 待取回的 revision
 * @returns {Promise<boolean>} 取回成功时为 true
 */
export async function fetchRevision(cwd, rev) {
	/** @type {string[]} */
	let remotes
	try {
		remotes = (await runGit(['remote'], cwd)).split('\n').map((line) => line.trim()).filter(Boolean)
	}
	catch {
		return false
	}
	for (const remote of remotes)
		try {
			await runGit(['fetch', '--no-tags', '--quiet', remote, rev], cwd)
			if (await objectExists(cwd, rev)) return true
		}
		catch {
			// 换个远端继续试。
		}
	return false
}

/**
 * 把单个 commit 钉到基线 ref 命名空间下，避免被 gc 回收。不清理其他 ref。
 *
 * @param {string} cwd - 仓库内任意目录
 * @param {string} rev - 基线 SHA
 * @returns {Promise<void>}
 */
export async function pinRevision(cwd, rev) {
	await runGit(['update-ref', `${BASELINE_REF_PREFIX}${rev}`, rev], cwd)
}

/**
 * 让基线 ref 命名空间与给定集合保持一致：钉住集合内的 commit，删掉集合外的旧 ref。
 * 只保留当前记录用到的基线，避免 refs 越积越多。
 *
 * @param {string} cwd - 仓库内任意目录
 * @param {string[]} revs - 需要保持可达的基线 SHA
 * @returns {Promise<void>}
 */
export async function syncBaselineRefs(cwd, revs) {
	const desired = new Set(revs.filter(Boolean))
	/** @type {string[]} */
	let existing
	try {
		const out = await runGit(['for-each-ref', '--format=%(refname)', BASELINE_REF_PREFIX], cwd)
		existing = out.split('\n').map((line) => line.trim()).filter(Boolean)
	}
	catch {
		return
	}
	for (const ref of existing)
		if (!desired.has(ref.slice(BASELINE_REF_PREFIX.length))) await runGit(['update-ref', '-d', ref], cwd)
	for (const rev of desired)
		await runGit(['update-ref', `${BASELINE_REF_PREFIX}${rev}`, rev], cwd)
}

/**
 * 读取当前 HEAD 的 commit SHA。仓库尚无提交时返回 undefined。
 *
 * @param {string} cwd - 仓库内任意目录
 * @returns {Promise<string | undefined>} HEAD 的 SHA，未出生时为 undefined
 */
export async function getHeadSha(cwd) {
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
export async function getRepoPrefix(cwd) {
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
export async function listTracked(repoRoot, rel) {
	return splitZ(await runGit(['ls-files', '-z', ...pathspec(rel)], repoRoot))
}

/**
 * 列出目录下未被跟踪、且未被 `.gitignore` 忽略的文件。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} rel - 相对仓库根的路径，空串表示整棵仓库
 * @returns {Promise<string[]>} 相对仓库根的 POSIX 路径
 */
export async function listUntracked(repoRoot, rel) {
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
export async function listChanged(repoRoot, sha, rel) {
	return splitZ(await runGit(
		['diff', '--no-renames', '--name-only', '--diff-filter=d', '-z', sha, ...pathspec(rel)],
		repoRoot
	))
}
