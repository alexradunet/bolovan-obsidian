import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const isProduction = process.argv[2] === "production";

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
  outfile: "main.js",
  minify: isProduction,
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
