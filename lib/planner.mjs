import fs from 'node:fs'
import path from 'node:path'

import { getRepoPrefix, listChanged, listTracked, listUntracked } from './git.mjs'
import { normalizeRel, resolveBaseline } from './state.mjs'

/**
 * 计算目标目录相对仓库根的 POSIX 路径，交给 git 解析以避开 Windows 短路径/长路径混用的问题。
 *
 * @param {string} target - 目标目录
 * @returns {Promise<string>} 相对路径，仓库根为空串
 */
export async function toRepoRelative(target) {
	return normalizeRel(await getRepoPrefix(target))
}

/**
 * 判断路径是否为磁盘上的普通文件（跳过已被删除的索引项和 submodule 占位目录）。
 *
 * @param {string} file - 绝对路径
 * @returns {boolean} 是普通文件时为真
 */
function isRegularFile(file) {
	try {
		return fs.statSync(file).isFile()
	}
	catch {
		return false
	}
}

/**
 * 算出目标目录下需要格式化的文件。
 *
 * 被跟踪的文件按其所在目录的“最深层基线”分组：若从未格式化过（无基线）则整组都算待处理，
 * 否则只取基线 commit 与工作区之间发生改动的文件。任何未跟踪且未被忽略的文件始终纳入。
 *
 * @param {object} options - 参数
 * @param {string} options.repoRoot - 仓库根目录
 * @param {{ subpaths: Record<string, string> }} options.state - 记录内容
 * @param {string} options.target - 被右键的目标目录
 * @param {boolean} [options.includeUntracked] - 是否纳入未跟踪文件
 * @returns {Promise<{ relTarget: string, files: string[] }>} 相对路径与待格式化文件的绝对路径（已排序）
 */
export async function planFiles({ repoRoot, state, target, includeUntracked = true }) {
	const relTarget = await toRepoRelative(target)
	const tracked = await listTracked(repoRoot, relTarget)
	const untracked = includeUntracked ? await listUntracked(repoRoot, relTarget) : []

	/** @type {Map<string | null, string[]>} */
	const groups = new Map()
	for (const file of tracked) {
		const baseline = resolveBaseline(state, path.posix.dirname(file)) || null
		const group = groups.get(baseline)
		if (group) group.push(file)
		else groups.set(baseline, [file])
	}

	/** @type {Set<string>} */
	const selected = new Set()
	for (const [baseline, files] of groups) {
		if (!baseline) {
			for (const file of files) selected.add(file)
			continue
		}

		// 基线可能已被 rebase/GC 掉；取不到改动列表时保守地整组重算，而不是漏掉。
		/** @type {Set<string> | undefined} */
		let changed
		try {
			changed = new Set(await listChanged(repoRoot, baseline, ''))
		}
		catch {
			changed = undefined
		}
		for (const file of files)
			if (!changed || changed.has(file)) selected.add(file)
	}

	for (const file of untracked) selected.add(file)

	const files = []
	for (const rel of selected) {
		const absolute = path.resolve(repoRoot, rel)
		if (isRegularFile(absolute)) files.push(absolute)
	}
	files.sort()
	return { relTarget, files }
}
