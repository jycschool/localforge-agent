import * as esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const builds = [
  {
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: ["src/renderer/app.ts"],
    outfile: "dist/renderer.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome142",
    sourcemap: true,
    logLevel: "info",
  },
];

async function copyStaticAssets() {
  await mkdir("dist", { recursive: true });
  await Promise.all([
    copyFile("src/renderer/index.html", "dist/index.html"),
    copyFile("src/renderer/styles.css", "dist/styles.css"),
    copyFile("media/repoforge-icon.svg", "dist/app-icon.svg"),
    copyFile("media/repoforge-icon.png", "dist/app-icon.png"),
  ]);
}

if (watch) {
  await copyStaticAssets();
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching desktop application sources...");
} else {
  await rm("dist", { recursive: true, force: true });
  await copyStaticAssets();
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
