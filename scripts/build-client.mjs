#!/usr/bin/env node
/**
 * 把浏览器半边 `src/client/index.tsx` 打成 dsh 的 ModuleLoader 能直接加载的
 * `lib/client.js`。
 *
 * 包装格式是从官方 dsh-client-ui 各包 `lib/client.js` 的头尾逐字抄来的：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })
 * 工厂里手写的 `module` / `exports` / `Symbol.toStringTag` 正是 esbuild CJS
 * 输出期望的运行环境，所以 `format: 'cjs'` + banner/footer 即可，不需要额外
 * 的加载器。
 *
 * `external` 决定产物里留下哪些 `require(...)`：
 *   - `react` / `react/jsx-runtime` 是平台 seed（前端静态模块表提供）；
 *   - `@deepseek-ai/*` 同理（`@deepseek-ai/dsh-client-ui-primitives` 是 seed，
 *     其余按 boot graph 的行来）。跨插件只能通过 cordis 服务协作，把官方包
 *     打进来会复制出第二份组件与 CSS，所以一律 external。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const banner = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `		Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
		return module.exports;
	}
});
`

await build({
  entryPoints: [join(root, 'src', 'client', 'index.tsx')],
  outfile: join(root, 'lib', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
})
