/* global suite: readonly, test: readonly */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getHeadSha, getRepoRoot } from '../lib/git.mjs'
import { planFiles } from '../lib/planner.mjs'
import { emptyState, recordFormatted, resolveBaseline } from '../lib/state.mjs'

import { removeDir } from './helpers.mjs'

/**
 * 同步运行一条 git 命令。
 *
 * @param {string} cwd - 运行目录
 * @param {...string} args - git 参数
 * @returns {string} 标准输出
 */
function git(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 创建一个带提交的临时仓库。
 *
 * @param {Record<string, string>} files - 相对路径到内容的映射
 * @returns {{ dir: string }} 仓库目录
 */
function makeRepo(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-format-all-planner-'))
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'better-format-all tests')
	git(dir, 'config', 'commit.gpgsign', 'false')
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(dir, name)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, content)
	}
	return { dir }
}

/**
 * 暂存全部并提交。
 *
 * @param {string} dir - 仓库目录
 * @param {string} message - 提交信息
 * @returns {string} 新提交的 SHA
 */
function commit(dir, message) {
	git(dir, 'add', '-A')
	git(dir, 'commit', '-q', '-m', message)
	return git(dir, 'rev-parse', 'HEAD').trim()
}

/**
 * 把绝对路径列表转成相对仓库根、以 `/` 分隔并排序的数组。
 *
 * @param {string} root - 仓库根
 * @param {string[]} files - 绝对路径
 * @returns {string[]} 相对路径
 */
function relatives(root, files) {
	return files.map((file) => path.relative(root, file).replace(/\\/g, '/')).sort()
}

suite('better-format-all planner', () => {
	test('formats every tracked file plus untracked non-ignored files without a baseline', async () => {
		const { dir } = makeRepo({
			'a.txt': 'a',
			'sub/b.txt': 'b',
			'.gitignore': 'ignored/\n'
		})
		try {
			commit(dir, 'init')
			fs.mkdirSync(path.join(dir, 'ignored'))
			fs.writeFileSync(path.join(dir, 'ignored', 'c.txt'), 'c')
			fs.writeFileSync(path.join(dir, 'untracked.txt'), 'd')
			const repoRoot = await getRepoRoot(dir)
			const { files } = await planFiles({ repoRoot, state: emptyState(), target: repoRoot })
			assert.deepStrictEqual(relatives(repoRoot, files), ['.gitignore', 'a.txt', 'sub/b.txt', 'untracked.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('honours the recorded baseline and always includes uncommitted changes', async () => {
		const { dir } = makeRepo({ 'a.txt': 'a', 'sub/b.txt': 'b' })
		try {
			const head = commit(dir, 'init')
			fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u')
			const repoRoot = await getRepoRoot(dir)
			const state = recordFormatted(emptyState(), '', head)

			fs.writeFileSync(path.join(dir, 'a.txt'), 'a changed')
			const { files } = await planFiles({ repoRoot, state, target: repoRoot })
			assert.deepStrictEqual(relatives(repoRoot, files), ['a.txt', 'untracked.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('uses the deepest baseline so a freshly formatted subtree is skipped', async () => {
		const { dir } = makeRepo({ 'a.txt': 'a', 'sub/b.txt': 'b1' })
		try {
			const first = commit(dir, 'first')
			fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b2')
			const second = commit(dir, 'second')
			const repoRoot = await getRepoRoot(dir)

			let state = recordFormatted(emptyState(), '', first)
			state = recordFormatted(state, 'sub', second)
			// 若 sub/b.txt 用了根基线 first，它会被算作改动；最深层条目 second 才是正确答案。
			assert.strictEqual(resolveBaseline(state, 'sub'), second)

			const { files } = await planFiles({ repoRoot, state, target: repoRoot })
			assert.deepStrictEqual(relatives(repoRoot, files), [])
		}
		finally {
			removeDir(dir)
		}
	})

	test('compares against the merge base when the baseline sits on another fork', async () => {
		const { dir } = makeRepo({ 'base.txt': 'base', 'sub/x.txt': 'x' })
		try {
			const root = commit(dir, 'base')
			// forkA 是基线所在的分叉，只改了 base.txt。
			git(dir, 'checkout', '-q', '-b', 'forkA')
			fs.writeFileSync(path.join(dir, 'base.txt'), 'a-change')
			const baseline = commit(dir, 'a-change')
			// forkB 是当前分叉，从共同祖先出来只改了 sub/x.txt。
			git(dir, 'checkout', '-q', root)
			git(dir, 'checkout', '-q', '-b', 'forkB')
			fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'b-change')
			commit(dir, 'b-change')

			const repoRoot = await getRepoRoot(dir)
			const state = recordFormatted(emptyState(), '', baseline)
			const { files } = await planFiles({ repoRoot, state, target: repoRoot })
			// 直接 `git diff <基线>` 会把 base.txt（forkA 独有改动）也算进来；正确结果只认当前分叉的改动。
			assert.deepStrictEqual(relatives(repoRoot, files), ['sub/x.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('does not reformat everything after a metadata-only rewrite of an old commit', async () => {
		const { dir } = makeRepo({ 'root.txt': 'root' })
		try {
			commit(dir, 'root')
			fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
			commit(dir, 'reword me')
			fs.writeFileSync(path.join(dir, 'y.txt'), 'y')
			commit(dir, 'second')
			fs.writeFileSync(path.join(dir, 'z.txt'), 'z')
			const baseline = commit(dir, 'baseline commit')
			fs.writeFileSync(path.join(dir, 'w.txt'), 'w')
			commit(dir, 'fourth')

			// 只改三年前那条 commit 的标题，重建它并把它之后的提交 rebase 过去。祖先链 SHA 全变，
			// 但内容一个字节没动。
			const old = git(dir, 'rev-parse', 'HEAD~3').trim()
			const tree = git(dir, 'rev-parse', `${old}^{tree}`).trim()
			const parent = git(dir, 'rev-parse', `${old}^`).trim()
			const reworded = git(dir, 'commit-tree', tree, '-p', parent, '-m', 'reworded title').trim()
			git(dir, 'rebase', '--onto', reworded, old, 'HEAD')

			const repoRoot = await getRepoRoot(dir)
			const state = recordFormatted(emptyState(), '', baseline)
			const { files } = await planFiles({ repoRoot, state, target: repoRoot })
			// 合并基点会退到被改 commit 的父提交，若只按合并基点比会把 x/y/z 也重算；正确结果只认基线之后真正改动的 w.txt。
			assert.deepStrictEqual(relatives(repoRoot, files), ['w.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('recovers a gc-ed baseline from the remote instead of reformatting everything', async () => {
		const { dir } = makeRepo({ 'root.txt': 'root' })
		const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'better-format-all-remote-'))
		try {
			commit(dir, 'root')
			fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
			const baseline = commit(dir, 'baseline')
			const baselineParent = git(dir, 'rev-parse', 'HEAD^').trim()
			const baselineTree = git(dir, 'rev-parse', `${baseline}^{tree}`).trim()
			fs.writeFileSync(path.join(dir, 'y.txt'), 'y')
			const tip = commit(dir, 'after baseline')
			const tipTree = git(dir, 'rev-parse', `${tip}^{tree}`).trim()

			// 远端先留一份带基线的历史，再把本地基线 commit 改标题后 reset 过去并 gc 掉旧对象，
			// 模拟「基线已被回收，只剩远端还留着」的旧记录。
			git(dir, 'clone', '-q', '--bare', dir, remote)
			git(dir, 'remote', 'add', 'origin', remote)

			const reworded = git(dir, 'commit-tree', baselineTree, '-p', baselineParent, '-m', 'reworded').trim()
			const rewrittenTip = git(dir, 'commit-tree', tipTree, '-p', reworded, '-m', 'after baseline').trim()
			git(dir, 'reset', '--hard', rewrittenTip)
			git(dir, 'reflog', 'expire', '--expire=now', '--all')
			git(dir, 'gc', '--prune=now', '--quiet')
			assert.throws(() => git(dir, 'cat-file', '-e', `${baseline}^{commit}`), 'baseline should be gc-ed locally')

			const repoRoot = await getRepoRoot(dir)
			const state = recordFormatted(emptyState(), '', baseline)
			const { files } = await planFiles({ repoRoot, state, target: repoRoot })
			// 取回基线后只按真实内容改动选择，而不是因为没有基线就整组重算。
			assert.deepStrictEqual(relatives(repoRoot, files), ['y.txt'])
			// 取回的基线被 ref 钉住，下次不会再被回收。
			assert.match(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/better-format-all/'), new RegExp(baseline))
		}
		finally {
			removeDir(dir)
			removeDir(remote)
		}
	})

	test('honours includeUntracked=false and limits the walk to the target folder', async () => {
		const { dir } = makeRepo({ 'sub/a.txt': 'a', 'other/b.txt': 'b' })
		try {
			commit(dir, 'init')
			fs.writeFileSync(path.join(dir, 'sub', 'u.txt'), 'u')
			const repoRoot = await getRepoRoot(dir)

			const { files, relTarget } = await planFiles({
				repoRoot,
				state: emptyState(),
				target: path.join(dir, 'sub'),
				includeUntracked: false
			})
			assert.strictEqual(relTarget, 'sub')
			assert.deepStrictEqual(relatives(repoRoot, files), ['sub/a.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('ignores binary files with a NUL byte in the first 8 KiB', async () => {
		const { dir } = makeRepo({ 'a.txt': 'a' })
		try {
			fs.writeFileSync(path.join(dir, 'blob.bin'), new Uint8Array([0x74, 0x65, 0x78, 0x74, 0x00, 0x62]))
			commit(dir, 'init')
			// 未跟踪的二进制文件同样应被忽略。
			fs.writeFileSync(path.join(dir, 'untracked.bin'), new Uint8Array([0x00, 0x01, 0x02]))
			const repoRoot = await getRepoRoot(dir)
			const { files } = await planFiles({ repoRoot, state: emptyState(), target: repoRoot })
			assert.deepStrictEqual(relatives(repoRoot, files), ['a.txt'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('keeps files whose first NUL appears past the 8 KiB sniff window', async () => {
		const { dir } = makeRepo({ 'a.txt': 'a' })
		try {
			const late = new Uint8Array(8 * 1024 + 1)
			late.fill(0x61)
			late[8 * 1024] = 0x00
			fs.writeFileSync(path.join(dir, 'late.bin'), late)
			commit(dir, 'init')
			const repoRoot = await getRepoRoot(dir)
			const { files } = await planFiles({ repoRoot, state: emptyState(), target: repoRoot })
			assert.deepStrictEqual(relatives(repoRoot, files), ['a.txt', 'late.bin'])
		}
		finally {
			removeDir(dir)
		}
	})

	test('reports no repository outside a git working tree', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-format-all-norepo-'))
		try {
			assert.strictEqual(await getRepoRoot(dir), undefined)
			assert.strictEqual(await getHeadSha(dir), undefined)
		}
		finally {
			removeDir(dir)
		}
	})
})
