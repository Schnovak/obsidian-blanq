import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Copy WASM and model files to output
function copyAssets() {
  const outDir = __dirname;
  const ortDir = join(__dirname, "node_modules", "onnxruntime-web", "dist");

  // Copy ONNX Runtime WASM files + JS bundle
  if (existsSync(ortDir)) {
    for (const f of readdirSync(ortDir)) {
      if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
        copyFileSync(join(ortDir, f), join(outDir, f));
      }
    }
    // Copy the UMD bundle for runtime loading
    const ortJs = join(ortDir, "ort.all.min.js");
    if (existsSync(ortJs)) {
      copyFileSync(ortJs, join(outDir, "ort.all.min.js"));
    }
  }

  // Copy the ONNX model from parent project
  const modelSrc = join(__dirname, "..", "FFDNet-S.onnx");
  if (existsSync(modelSrc)) {
    copyFileSync(modelSrc, join(outDir, "FFDNet-S.onnx"));
  }
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "node",
  format: "cjs",
  external: ["obsidian", "electron", "canvas", "./ort.all.min.js"],
  sourcemap: false,
  treeShaking: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
  plugins: [
    {
      name: "copy-assets",
      setup(build) {
        build.onEnd(() => {
          copyAssets();
        });
      },
    },
  ],
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
