import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_STATE_FILE = 'format-all.json'
export const STATE_VERSION = 1

/**
 * 把路径规范化为相对仓库根的 POSIX 形式：仓库根是空串，不带 `./` 前缀和结尾斜杠。
 *
 * @param {unknown} value - 待规范化的路径
 * @returns {string} 规范化后的相对路径
 */
export function normalizeRel (value) {
	let rel = String(value ?? '').replace(/\\/g, '/')
	rel = rel.replace(/^\.\//, '')
	if (rel === '.' || rel === './') rel = ''
	return rel.replace(/\/+$/, '')
}

/**
 * 构造一个空的记录。
 *
 * @returns {{ version: number, subpaths: Record<string, string> }} 空记录
 */
export function emptyState () {
	return { version: STATE_VERSION, subpaths: {} }
}

/**
 * 解析记录文件的绝对路径。
 *
 * @param {string} gitDir - git 目录
 * @param {string} [fileName] - 记录文件名
 * @returns {string} 记录文件路径
 */
export function statePath (gitDir, fileName = DEFAULT_STATE_FILE) {
	return path.join(gitDir, fileName || DEFAULT_STATE_FILE)
}

/**
 * 读取记录。文件缺失、损坏或字段类型不对时退回空记录，绝不抛出。
 *
 * @param {string} gitDir - git 目录
 * @param {string} [fileName] - 记录文件名
 * @returns {{ version: number, subpaths: Record<string, string> }} 记录内容
 */
export function readState (gitDir, fileName) {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(gitDir, fileName), 'utf8'))
		const source = parsed && typeof parsed === 'object' && parsed.subpaths && typeof parsed.subpaths === 'object'
			? parsed.subpaths
			: {}
		/** @type {Record<string, string>} */
		const subpaths = {}
		for (const [key, value] of Object.entries(source))
			if (typeof value === 'string') subpaths[normalizeRel(key)] = value
		return { version: STATE_VERSION, subpaths }
	}
	catch {
		return emptyState()
	}
}

/**
 * 原子地写入记录：先写同目录临时文件再改名，避免中途崩溃留下半截 JSON。
 *
 * @param {string} gitDir - git 目录
 * @param {{ subpaths: Record<string, string> }} state - 记录内容
 * @param {string} [fileName] - 记录文件名
 * @returns {void}
 */
export function writeState (gitDir, state, fileName) {
	const file = statePath(gitDir, fileName)
	const payload = `${JSON.stringify({ version: STATE_VERSION, subpaths: state.subpaths }, null, '\t')}\n`
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, payload, 'utf8')
	fs.renameSync(tmp, file)
}

/**
 * 找出 `rel` 自身或最深层祖先上记录的基线：先看 `rel`，再逐级向上直到仓库根。
 *
 * 取最深层的一条而不是根条目，是为了让对某个子目录单独格式化后，下次处理其父目录时能少算已格式化的部分。
 *
 * @param {{ subpaths: Record<string, string> }} state - 记录内容
 * @param {string} rel - 相对仓库根的路径
 * @returns {string | undefined} 基线 commit SHA，未记录时为 undefined
 */
export function resolveBaseline (state, rel) {
	let current = normalizeRel(rel)
	while (true) {
		if (Object.prototype.hasOwnProperty.call(state.subpaths, current)) return state.subpaths[current]
		if (current === '') return undefined
		const index = current.lastIndexOf('/')
		current = index === -1 ? '' : current.slice(0, index)
	}
}

/**
 * 记录 `rel` 已于 `sha` 完整格式化：清掉它自身以及它内部所有更细的旧条目，再写入这一条。
 *
 * 父目录被完整格式化后，内部子目录的旧基线都变得多余；保留它们只会让下次计算多算改动，因此直接清除。
 * `sha` 缺失（仓库尚无提交）时不改动记录。
 *
 * @param {{ subpaths: Record<string, string> }} state - 记录内容
 * @param {string} rel - 被完整格式化的路径，仓库根为空串
 * @param {string | undefined} sha - 对应的 commit SHA
 * @returns {{ version: number, subpaths: Record<string, string> }} 更新后的记录
 */
export function recordFormatted (state, rel, sha) {
	if (!sha) return state

	const norm = normalizeRel(rel)
	/** @type {Record<string, string>} */
	const subpaths = {}
	for (const [key, value] of Object.entries(state.subpaths)) {
		if (key === norm) continue
		if (norm === '') {
			if (key !== '') continue
		}
		else if (key.startsWith(`${norm}/`)) continue
		subpaths[key] = value
	}
	subpaths[norm] = sha
	return { version: STATE_VERSION, subpaths }
}
