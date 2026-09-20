import fs from 'node:fs'
import path from 'node:path'

/**
 * 递归清除 Windows 只读属性。git 会把 `.git/objects` 下的对象文件设为只读，
 * 直接 `fs.rmSync(..., { force: true })` 会在这些文件上抛 EPERM。
 *
 * @param {string} target - 要处理的文件或目录
 * @returns {void}
 */
function makeWritable (target) {
	let stat
	try {
		stat = fs.lstatSync(target)
	}
	catch {
		return
	}
	try {
		fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666)
	}
	catch {
		// 某些文件（如正在被占用的 .lock）改不动也无妨，后面的重试会处理。
	}
	if (!stat.isDirectory()) return
	let entries = []
	try {
		entries = fs.readdirSync(target)
	}
	catch {
		return
	}
	for (const entry of entries) makeWritable(path.join(target, entry))
}

/**
 * 同步休眠。
 *
 * @param {number} ms - 毫秒数
 * @returns {void}
 */
function sleep (ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 删除临时目录，先清掉只读属性再删。VS Code 关掉编辑器后可能仍短暂持有文件句柄，因此带重试；
 * 临时目录清不掉不应让测试本身失败，最后一次失败会被吞掉。
 *
 * @param {string} dir - 目录
 * @returns {void}
 */
export function removeDir (dir) {
	if (!fs.existsSync(dir)) return
	for (let attempt = 0; attempt < 5; attempt++) {
		makeWritable(dir)
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
			return
		}
		catch {
			sleep(200)
		}
	}
}
