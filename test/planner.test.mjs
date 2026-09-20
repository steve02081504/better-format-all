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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-all-planner-'))
	git(dir, 'init', '-q')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'format-all tests')
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

suite('format-all planner', () => {
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

	test('reports no repository outside a git working tree', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-all-norepo-'))
		try {
			assert.strictEqual(await getRepoRoot(dir), undefined)
			assert.strictEqual(await getHeadSha(dir), undefined)
		}
		finally {
			removeDir(dir)
		}
	})
})
