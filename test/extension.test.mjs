/* global suite: readonly, test: readonly, suiteSetup: readonly */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as vscode from 'vscode'

import { removeDir } from './helpers.mjs'

const FORMAT_ALL_COMMAND = 'formatAll.formatFolder'

/**
 * 同步运行一条 git 命令。
 *
 * @param {string} cwd - 运行目录
 * @param {...string} args - git 参数
 * @returns {string} 标准输出
 */
function git (cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 取整个文档的范围。
 *
 * @param {vscode.TextDocument} document - 目标文档
 * @returns {vscode.Range} 覆盖全文的范围
 */
function fullRange (document) {
	const lastLine = Math.max(document.lineCount - 1, 0)
	return new vscode.Range(new vscode.Position(0, 0), document.lineAt(lastLine).range.end)
}

suite('format-all extension', () => {
	suiteSetup(async () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'format-all')
		if (extension && !extension.isActive) await extension.activate()
	})

	test('formats changed and untracked files with the default formatter and records the baseline', async function () {
		this.timeout(120000)
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-all-ext-'))
		// 用一个只对本测试生效的格式化器（大写整篇文档），等价于用户为该语言配置的默认格式化器。
		const registration = vscode.languages.registerDocumentFormattingEditProvider({ language: 'plaintext' }, {
			/**
			 * 把整篇文档转成大写；已经是全大写时返回空编辑。
			 *
			 * @param {vscode.TextDocument} document - 目标文档
			 * @returns {vscode.TextEdit[]} 格式化编辑
			 */
			provideDocumentFormattingEdits (document) {
				const text = document.getText()
				const upper = text.toUpperCase()
				return upper === text ? [] : [vscode.TextEdit.replace(fullRange(document), upper)]
			}
		})

		try {
			git(dir, 'init', '-q')
			git(dir, 'config', 'user.email', 'test@example.com')
			git(dir, 'config', 'user.name', 'format-all tests')
			git(dir, 'config', 'commit.gpgsign', 'false')
			fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n')
			fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
			fs.mkdirSync(path.join(dir, 'sub'))
			fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world')
			git(dir, 'add', '-A')
			git(dir, 'commit', '-q', '-m', 'init')
			const head = git(dir, 'rev-parse', 'HEAD').trim()

			fs.writeFileSync(path.join(dir, 'untracked.txt'), 'cap me')
			fs.mkdirSync(path.join(dir, 'ignored'))
			fs.writeFileSync(path.join(dir, 'ignored', 'i.txt'), 'keep me')

			await vscode.commands.executeCommand(FORMAT_ALL_COMMAND, vscode.Uri.file(dir))

			assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'HELLO')
			assert.strictEqual(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'WORLD')
			assert.strictEqual(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'CAP ME')
			assert.strictEqual(fs.readFileSync(path.join(dir, 'ignored', 'i.txt'), 'utf8'), 'keep me')

			const stateFile = path.join(dir, '.git', 'format-all.json')
			assert.strictEqual(fs.existsSync(stateFile), true)
			const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
			assert.strictEqual(state.version, 1)
			assert.deepStrictEqual(state.subpaths, { '': head })

			// 打开过的文件都已关闭。
			for (const name of ['a.txt', 'sub/b.txt', 'untracked.txt']) {
				const uri = vscode.Uri.file(path.join(dir, name)).toString()
				assert.ok(
					!vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri),
					`${name} should be closed after formatting`
				)
			}

			// 第二次运行：内容已是最终形态，格式化器返回空编辑，磁盘内容保持不变。
			await vscode.commands.executeCommand(FORMAT_ALL_COMMAND, vscode.Uri.file(dir))
			assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'HELLO')
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).subpaths, { '': head })
		}
		finally {
			registration.dispose()
			await vscode.commands.executeCommand('workbench.action.closeAllEditors')
			removeDir(dir)
		}
	})

	test('warns instead of throwing outside a git repository', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-all-ext-norepo-'))
		try {
			// 不是仓库时不抛错，也不写任何文件。
			await vscode.commands.executeCommand(FORMAT_ALL_COMMAND, vscode.Uri.file(dir))
			assert.strictEqual(fs.existsSync(path.join(dir, '.git')), false)
		}
		finally {
			removeDir(dir)
		}
	})
})
