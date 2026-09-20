import fs from 'node:fs'

import * as vscode from 'vscode'

/**
 * 关闭由本扩展打开的那个标签页。按 URI 精确查找，避免误关别的编辑器。
 *
 * @param {vscode.Uri} uri - 文件地址
 * @returns {Promise<void>}
 */
async function closeTab(uri) {
	const target = uri.toString()
	const tab = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.find((candidate) => candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === target)
	if (!tab) return
	try {
		await vscode.window.tabGroups.close(tab)
	}
	catch {
		// 标签页可能已因格式化器或用户操作先一步关闭。
	}
}

/**
 * 用编辑器默认格式化器格式化单个文件：打开 → `editor.action.formatDocument` → 保存 → 关闭。
 *
 * 用 `editor.action.formatDocument`（等同“格式化文档”）而不是自行挑选 provider，因此走 `editor.defaultFormatter`；
 * 未配置默认格式化器时，VS Code 会按它自己的规则处理，本扩展不替它选第一个。
 *
 * 原本就打开且未保存的文件直接跳过，避免把用户未保存的改动一起写盘；已有可见编辑器不为它新建/关闭标签页。
 *
 * @param {vscode.Uri} uri - 文件地址
 * @returns {Promise<{ status: 'formatted' | 'unchanged' | 'skipped' | 'error', error?: Error }>} 处理结果
 */
export async function formatFile(uri) {
	try {
		fs.accessSync(uri.fsPath, fs.constants.W_OK)
	}
	catch {
		return { status: 'skipped' }
	}

	const opened = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString())
	if (opened) {
		if (opened.document.isDirty) return { status: 'skipped' }
	}

	let editor = opened
	let created = false
	if (!editor) {
		let document
		try {
			document = await vscode.workspace.openTextDocument(uri)
		}
		catch (error) {
			return { status: 'error', error }
		}
		if (document.uri.scheme !== 'file' || document.isUntitled) return { status: 'skipped' }
		try {
			editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false })
		}
		catch (error) {
			return { status: 'error', error }
		}
		created = true
	}

	if (!editor) return { status: 'skipped' }

	const { document } = editor
	const before = document.getText()
	try {
		await vscode.commands.executeCommand('editor.action.formatDocument')
	}
	catch (error) {
		if (created) await closeTab(uri)
		return { status: 'error', error }
	}

	if (document.isDirty) {
		try {
			await document.save()
		}
		catch (error) {
			if (created) await closeTab(uri)
			return { status: 'error', error }
		}
	}

	const changed = document.getText() !== before
	if (created) await closeTab(uri)
	return { status: changed ? 'formatted' : 'unchanged' }
}
