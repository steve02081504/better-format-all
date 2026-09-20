/* global suite: readonly, test: readonly */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	emptyState,
	normalizeRel,
	readState,
	recordFormatted,
	resolveBaseline,
	statePath,
	writeState
} from '../lib/state.mjs'

suite('better-format-all state', () => {
	test('normalizes relative paths to root-relative POSIX form', () => {
		assert.strictEqual(normalizeRel('.'), '')
		assert.strictEqual(normalizeRel(''), '')
		assert.strictEqual(normalizeRel('./'), '')
		assert.strictEqual(normalizeRel('./src'), 'src')
		assert.strictEqual(normalizeRel('src\\nested\\'), 'src/nested')
		assert.strictEqual(normalizeRel('src/nested//'), 'src/nested')
	})

	test('resolves the deepest recorded ancestor-or-self baseline', () => {
		const state = { subpaths: { '': 'root-sha', src: 'src-sha', 'src/deep': 'deep-sha' } }
		assert.strictEqual(resolveBaseline(state, 'src/deep/a.ts'), 'deep-sha')
		assert.strictEqual(resolveBaseline(state, 'src/other/a.ts'), 'src-sha')
		assert.strictEqual(resolveBaseline(state, 'top.ts'), 'root-sha')
		assert.strictEqual(resolveBaseline({ subpaths: {} }, 'top.ts'), undefined)
	})

	test('recording a formatted path clears its descendants and keeps ancestors', () => {
		const state = { subpaths: { '': 'root-sha', src: 'src-sha', 'src/deep': 'deep-sha', other: 'other-sha' } }
		const updated = recordFormatted(state, 'src', 'new-sha')
		assert.deepStrictEqual(updated.subpaths, { '': 'root-sha', other: 'other-sha', src: 'new-sha' })

		const rooted = recordFormatted(updated, '', 'root-new')
		assert.deepStrictEqual(rooted.subpaths, { '': 'root-new' })
	})

	test('recording without a commit SHA leaves the record untouched', () => {
		const state = { subpaths: { src: 'src-sha', deep: 'deep-sha' } }
		assert.strictEqual(recordFormatted(state, 'src', undefined), state)
	})

	test('round-trips through the state file and tolerates corruption', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-format-all-state-'))
		try {
			const state = recordFormatted(emptyState(), 'src', 'sha-1')
			writeState(dir, state)
			assert.strictEqual(fs.existsSync(statePath(dir)), true)
			assert.deepStrictEqual(readState(dir).subpaths, { src: 'sha-1' })

			fs.writeFileSync(statePath(dir), '{ not json', 'utf8')
			assert.deepStrictEqual(readState(dir).subpaths, {})

			fs.writeFileSync(statePath(dir), JSON.stringify({ subpaths: { src: 42, ok: 'x' } }), 'utf8')
			assert.deepStrictEqual(readState(dir).subpaths, { ok: 'x' })
		}
		finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
