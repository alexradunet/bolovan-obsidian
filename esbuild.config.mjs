import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const isProduction = process.argv[2] === "production";

const obsidianRuntimeCompatibility = {
  name: "obsidian-runtime-compatibility",
  setup(build) {
    build.onResolve({ filter: /clipboard-native\.js$/ }, (args) => ({
      path: args.path,
      namespace: "nazar-compatibility",
    }));

    build.onLoad({ filter: /.*/, namespace: "nazar-compatibility" }, () => ({
      contents: "export const clipboard = null; export function loadClipboardNative() { return null; }",
      loader: "js",
    }));
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  platform: "node",
  target: "es2021",
  logLevel: "info",
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  banner: {
    js: 'const __nazarImportMetaUrl = require("node:url").pathToFileURL(require("node:path").join(process.cwd(), ".nazar-runtime.js")).href;',
  },
  define: {
    "import.meta.url": "__nazarImportMetaUrl",
  },
  plugins: [obsidianRuntimeCompatibility],
  outfile: "main.js",
  minify: isProduction,
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
