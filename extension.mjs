import * as vscode from 'vscode'

import { formatFile } from './lib/formatRunner.mjs'
import { getAbsoluteGitDir, getHeadSha, getRepoRoot } from './lib/git.mjs'
import { planFiles } from './lib/planner.mjs'
import { DEFAULT_STATE_FILE, readState, recordFormatted, writeState } from './lib/state.mjs'

const OUTPUT_CHANNEL_NAME = 'better-format-all'

/** @type {vscode.OutputChannel | undefined} */
let outputChannel

/**
 * 本地化字符串辅助函数。
 *
 * @param {string} message - 本地化消息模板
 * @param {...any} args - 格式化参数列表
 * @returns {string} 本地化后的字符串
 */
function t(message, ...args) {
	return vscode.l10n.t(message, ...args)
}

/**
 * 获取共享输出通道。
 *
 * @returns {vscode.OutputChannel} 共享输出通道实例
 */
function getOutputChannel() {
	if (!outputChannel) outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
	return outputChannel
}

/**
 * 解析命令应作用的文件夹列表。资源管理器多选时 `selected` 是全部选中项，否则回退到 `resource`，
 * 都没有时用第一个工作区目录。
 *
 * @param {unknown} resource - 触发命令的主资源
 * @param {unknown} selected - 多选时的资源数组
 * @returns {string[]} 目标文件夹的绝对路径
 */
function resolveTargets(resource, selected) {
	const folders = []
	if (Array.isArray(selected))
		for (const uri of selected)
			if (uri instanceof vscode.Uri) folders.push(uri.fsPath)

	if (!folders.length && resource instanceof vscode.Uri) folders.push(resource.fsPath)
	if (!folders.length && vscode.workspace.workspaceFolders?.length)
		folders.push(vscode.workspace.workspaceFolders[0].uri.fsPath)
	return folders
}

/**
 * 创建本次运行的累计统计。
 *
 * @returns {{ targets: number, files: number, formatted: number, unchanged: number, skipped: number, failed: number, cancelled: boolean }} 统计对象
 */
function newSummary() {
	return { targets: 0, files: 0, formatted: 0, unchanged: 0, skipped: 0, failed: 0, cancelled: false }
}

/**
 * 处理一个目标目录：解析仓库、计算待格式化文件、逐个格式化，成功后写回基线。
 *
 * @param {string} target - 目标目录
 * @param {object} progress - VS Code 进度报告器
 * @param {vscode.CancellationToken} token - 取消令牌
 * @param {object} summary - 累计统计
 * @returns {Promise<void>}
 */
async function formatTarget(target, progress, token, summary) {
	const repoRoot = await getRepoRoot(target)
	if (!repoRoot) {
		vscode.window.showErrorMessage(t('{0} is not inside a git repository.', target))
		return
	}

	const gitDir = await getAbsoluteGitDir(target)
	const config = vscode.workspace.getConfiguration('betterFormatAll', vscode.Uri.file(target))
	const stateFile = config.get('stateFile', DEFAULT_STATE_FILE)
	const includeUntracked = config.get('includeUntracked', true)
	const state = readState(gitDir, stateFile)

	const { relTarget, files } = await planFiles({ repoRoot, state, target, includeUntracked })
	if (!files.length) {
		getOutputChannel().appendLine(t('Nothing to format under {0}.', target))
		return
	}

	summary.targets += 1
	const label = relTarget || '.'
	let completed = 0
	// 只统计本次目标自己的失败：别的目录失败不应阻止这个目录写回基线。
	let failed = 0
	for (const file of files) {
		if (token.isCancellationRequested) {
			summary.cancelled = true
			return
		}

		progress.report({ message: t('{0} ({1}/{2})', label, completed + 1, files.length) })
		const result = await formatFile(vscode.Uri.file(file))
		summary.files += 1
		completed += 1

		switch (result.status) {
			case 'formatted':
				summary.formatted += 1
				break
			case 'unchanged':
				summary.unchanged += 1
				break
			case 'skipped':
				summary.skipped += 1
				break
			case 'error':
				failed += 1
				summary.failed += 1
				getOutputChannel().appendLine(t('Failed to format {0}: {1}', file, result.error?.message || ''))
				break
		}
	}

	// 只有整个目标都跑完（未取消、无失败）才写回基线。中途取消时保留旧基线，
	// 未处理完的文件下次仍会因 `git diff <旧基线>` 或未跟踪状态被重新纳入，不会遗漏。
	if (summary.cancelled || failed) return

	const sha = await getHeadSha(repoRoot)
	if (sha) {
		writeState(gitDir, recordFormatted(state, relTarget, sha), stateFile)
		getOutputChannel().appendLine(t('Recorded {0} as the format baseline for {1}.', sha.slice(0, 12), label))
	}
}

/**
 * 遍历所有目标目录。
 *
 * @param {string[]} targets - 目标目录列表
 * @param {object} progress - VS Code 进度报告器
 * @param {vscode.CancellationToken} token - 取消令牌
 * @returns {Promise<object>} 累计统计
 */
async function formatTargets(targets, progress, token) {
	const summary = newSummary()
	for (const target of targets) {
		if (token.isCancellationRequested) {
			summary.cancelled = true
			break
		}
		await formatTarget(target, progress, token, summary)
	}
	return summary
}

/**
 * 汇总本次运行并提示用户。
 *
 * @param {object} summary - 累计统计
 * @returns {void}
 */
function report(summary) {
	const parts = [t('{0} formatted', summary.formatted), t('{0} unchanged', summary.unchanged)]
	if (summary.skipped) parts.push(t('{0} skipped', summary.skipped))
	if (summary.failed) parts.push(t('{0} failed', summary.failed))
	const details = parts.join(', ')

	if (summary.failed) {
		const showOutput = t('Show Output')
		vscode.window.showWarningMessage(t('Formatted {0} file(s): {1}', summary.files, details), showOutput)
			.then((choice) => {
				if (choice === showOutput) getOutputChannel().show(true)
			})
		return
	}
	if (summary.cancelled) vscode.window.showInformationMessage(t('Formatting cancelled: {0}', details))
	else if (summary.files) vscode.window.showInformationMessage(t('Formatted {0} file(s): {1}', summary.files, details))
	else vscode.window.showInformationMessage(t('Nothing to format.'))
}

/**
 * 激活扩展，注册格式化命令。
 *
 * @param {vscode.ExtensionContext} context - 扩展上下文，用于注册订阅
 */
export function activate(context) {
	outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
	context.subscriptions.push(outputChannel)

	context.subscriptions.push(vscode.commands.registerCommand('betterFormatAll.formatFolder', async (resource, selected) => {
		const targets = resolveTargets(resource, selected)
		if (!targets.length) {
			vscode.window.showWarningMessage(t('Select a folder to format.'))
			return
		}

		const summary = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: t('Formatting git-tracked files...'),
			cancellable: true
		}, (progress, token) => formatTargets(targets, progress, token))

		report(summary)
	}))
}

/**
 * 停用扩展，订阅会由 VS Code 自动释放。
 */
export function deactivate() {
	// 一切都通过 `context.subscriptions` 释放。
}
