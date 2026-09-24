import * as vscode from 'vscode'

import { formatFile } from './lib/formatRunner.mjs'
import { getAbsoluteGitDir, getHeadSha, getRepoRoot, syncBaselineRefs } from './lib/git.mjs'
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
 * 解析目标目录的仓库信息、配置、基线与待格式化文件，供后续格式化使用。
 *
 * @param {string} target - 目标目录
 * @returns {Promise<object | undefined>} 计划对象；目标不在 git 仓库内时为 undefined
 */
async function planTarget(target) {
	const repoRoot = await getRepoRoot(target)
	if (!repoRoot) {
		const message = t('{0} is not inside a git repository.', target)
		getOutputChannel().appendLine(message)
		vscode.window.showErrorMessage(message)
		return undefined
	}

	const gitDir = await getAbsoluteGitDir(target)
	const config = vscode.workspace.getConfiguration('betterFormatAll', vscode.Uri.file(target))
	const stateFile = config.get('stateFile', DEFAULT_STATE_FILE)
	const includeUntracked = config.get('includeUntracked', true)
	const state = readState(gitDir, stateFile)

	const { relTarget, files } = await planFiles({ repoRoot, state, target, includeUntracked })
	return { target, repoRoot, gitDir, stateFile, relTarget, files, state }
}

/**
 * 处理一个已规划好的目标目录：逐个格式化文件，成功后写回基线。
 *
 * @param {object} plan - `planTarget` 的结果
 * @param {object} progress - VS Code 进度报告器
 * @param {vscode.CancellationToken} token - 取消令牌
 * @param {object} summary - 累计统计
 * @param {{ done: number, total: number }} counter - 跨目标的进度计数
 * @returns {Promise<void>}
 */
async function formatTarget(plan, progress, token, summary, counter) {
	const { target, repoRoot, gitDir, stateFile, relTarget, files, state } = plan
	if (!files.length) {
		getOutputChannel().appendLine(t('Nothing to format under {0}.', target))
		return
	}

	summary.targets += 1
	const label = relTarget || '.'
	// 只统计本次目标自己的失败：别的目录失败不应阻止这个目录写回基线。
	let failed = 0
	for (const file of files) {
		if (token.isCancellationRequested) {
			summary.cancelled = true
			return
		}

		counter.done += 1
		progress.report({
			message: t('{0} ({1}/{2})', label, counter.done, counter.total),
			increment: counter.total ? 100 / counter.total : undefined
		})
		const result = await formatFile(vscode.Uri.file(file))
		summary.files += 1

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
		const next = recordFormatted(state, relTarget, sha)
		writeState(gitDir, next, stateFile)
		// 用 ref 把基线 commit 钉住，否则 amend/rebase 后它变成不可达对象，会被 gc 回收，
		// 下次规划就只能整组重算。
		await syncBaselineRefs(repoRoot, Object.values(next.subpaths))
		getOutputChannel().appendLine(t('Recorded {0} as the format baseline for {1}.', sha.slice(0, 12), label))
	}
}

/**
 * 先规划所有目标得到文件总数，再逐个格式化，让通知里的进度条反映整体进度。
 *
 * @param {string[]} targets - 目标目录列表
 * @param {object} progress - VS Code 进度报告器
 * @param {vscode.CancellationToken} token - 取消令牌
 * @returns {Promise<object>} 累计统计
 */
async function formatTargets(targets, progress, token) {
	const summary = newSummary()
	/** @type {object[]} */
	const plans = []
	for (const target of targets) {
		if (token.isCancellationRequested) {
			summary.cancelled = true
			break
		}
		const plan = await planTarget(target)
		if (plan) plans.push(plan)
	}
	if (summary.cancelled) return summary

	const total = plans.reduce((sum, plan) => sum + plan.files.length, 0)
	const counter = { done: 0, total }
	for (const plan of plans) {
		await formatTarget(plan, progress, token, summary, counter)
		if (summary.cancelled) break
	}
	return summary
}

/**
 * 把未预期的错误写进日志并展示给用户。
 *
 * @param {unknown} error - 捕获到的错误
 * @returns {void}
 */
function handleError(error) {
	const channel = getOutputChannel()
	channel.appendLine(t('An error occurred: {0}', error instanceof Error ? error.stack || error.message : String(error)))
	channel.show(true)
	const showOutput = t('Show Output')
	vscode.window.showErrorMessage(
		t('An error occurred while formatting: {0}', error instanceof Error ? error.message : String(error)),
		showOutput
	).then((choice) => {
		if (choice === showOutput) channel.show(true)
	})
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
		const channel = getOutputChannel()
		channel.show(true)
		const showOutput = t('Show Output')
		vscode.window.showWarningMessage(t('Formatted {0} file(s): {1}', summary.files, details), showOutput)
			.then((choice) => {
				if (choice === showOutput) channel.show(true)
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

		try {
			const summary = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: t('Formatting git-tracked files...'),
				cancellable: true
			}, (progress, token) => formatTargets(targets, progress, token))

			report(summary)
		}
		catch (error) {
			handleError(error)
		}
	}))
}

/**
 * 停用扩展，订阅会由 VS Code 自动释放。
 */
export function deactivate() {
	// 一切都通过 `context.subscriptions` 释放。
}
