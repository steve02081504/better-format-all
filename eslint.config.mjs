import sharedConfig from 'https://cdn.jsdelivr.net/gh/steve02081504/my-eslint-config/deno.mjs'

const base = Array.isArray(sharedConfig) ? sharedConfig : [sharedConfig]

/**
 * ESLint 配置。忽略测试时生成/下载的目录（`.vscode-test` 里是 VS Code 自带的脚本），其余沿用公共配置。
 * @type {import('eslint').Linter.FlatConfig[]}
 */
export default [
	{ ignores: ['.vscode-test/**', 'node_modules/**', '.vscode/**', '*.vsix'] },
	...base
]
