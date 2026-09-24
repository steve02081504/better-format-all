import fs from 'node:fs'
import path from 'node:path'

import { fetchRevision, getMergeBase, getRepoPrefix, listChanged, listTracked, listUntracked, objectExists, pinRevision } from './git.mjs'
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
 * 嗅探文件开头多少字节来判定是否为二进制。
 */
const BINARY_SNIFF_SIZE = 8 * 1024

/**
 * 判断文件是否为二进制：开头 `BINARY_SNIFF_SIZE` 字节内出现 NUL 字节即视为二进制，应跳过格式化。
 *
 * @param {string} file - 绝对路径
 * @returns {boolean} 是二进制文件时为真
 */
function isBinaryFile(file) {
	let fd
	try {
		fd = fs.openSync(file, 'r')
		const buffer = new Uint8Array(BINARY_SNIFF_SIZE)
		const bytes = fs.readSync(fd, buffer, 0, BINARY_SNIFF_SIZE, 0)
		return buffer.subarray(0, bytes).includes(0)
	}
	catch {
		return false
	}
	finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}

/**
 * 确保基线 commit 可用：本地已有时直接钉住以防被 gc 回收；缺失时尝试从远端按 SHA 取回，
 * 取回后再钉住。取不到返回 false。
 *
 * @param {string} repoRoot - 仓库根目录
 * @param {string} baseline - 基线 commit SHA
 * @returns {Promise<boolean>} 基线可用时为 true
 */
async function ensureBaseline(repoRoot, baseline) {
	if (await objectExists(repoRoot, baseline)) {
		await pinRevision(repoRoot, baseline)
		return true
	}
	if (await fetchRevision(repoRoot, baseline)) {
		await pinRevision(repoRoot, baseline)
		return true
	}
	return false
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

		// 基线可能已被 rebase/GC 掉，也可能位于另一条分叉上。先确保基线 commit 可用——本地缺失时
		// 从远端按 SHA 取回，并用 ref 钉住防止再次被回收；再取「工作区相对基线内容」的改动（精确反映
		// 内容是否变化）与「工作区相对合并基点」的改动（限定在当前这条历史自身）的交集。切分支时不会把
		// 另一条分叉独有的改动算进来；仅改某条老 commit 的元数据时，祖先链 SHA 全变会让合并基点一路退到
		// 被改 commit 的父提交，交集也不会把之后的所有改动重算。基线取不到时保守地整组重算，而不是漏掉。
		/** @type {Set<string> | undefined} */
		let changed
		try {
			if (await ensureBaseline(repoRoot, baseline)) {
				changed = new Set(await listChanged(repoRoot, baseline, ''))
				const base = await getMergeBase(repoRoot, baseline, 'HEAD')
				if (base && base !== baseline) {
					const onCurrentLine = new Set(await listChanged(repoRoot, base, ''))
					for (const file of changed)
						if (!onCurrentLine.has(file)) changed.delete(file)
				}
			}
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
		if (isRegularFile(absolute) && !isBinaryFile(absolute)) files.push(absolute)
	}
	files.sort()
	return { relTarget, files }
}
