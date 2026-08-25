/* esbuild 打包：src/main.js → 单文件 main.js（挂到 .obsidian/plugins/<id>/ 即用）。
 * obsidian 与 node 内置模块保持 external（Obsidian 桌面插件环境可 require('child_process') 等）。
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  alias: {
    // xlsx 库内部 require("fs") 用于可选的 set_fs 路径；插件从不调用，
    // 用空 stub 消除产物中的 Node fs 引用（Obsidian 审核 Direct Filesystem Access 警告）
    fs: "./stubs/fs.js",
  },
  external: [
    "obsidian",
    "path",
    "crypto",
    "stream",
    "util",
    "child_process",
    "os",
    "zlib",
    "events",
    "buffer",
    "assert",
    "tty",
    "string_decoder",
    "perf_hooks",
    "worker_threads",
    "net",
    "http",
    "https",
    "url",
    // Obsidian 运行时内置的 CodeMirror 6 包（不可打包，需 external 由 Obsidian 注入）
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/commands",
  ],
  logLevel: "info",
});

console.log("built main.js OK");