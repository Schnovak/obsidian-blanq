import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

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

  // Copy onnxruntime-node + onnxruntime-common for native inference
  // Only copy the current platform's binary to avoid 500+ MB of cross-platform binaries
  const pluginNM = join(outDir, "node_modules");
  mkdirSync(pluginNM, { recursive: true });

  const commonSrc = join(__dirname, "node_modules", "onnxruntime-common");
  if (existsSync(commonSrc)) {
    copyDirSync(commonSrc, join(pluginNM, "onnxruntime-common"));
  }

  const ortNodeSrc = join(__dirname, "node_modules", "onnxruntime-node");
  if (existsSync(ortNodeSrc)) {
    const ortNodeDest = join(pluginNM, "onnxruntime-node");
    // Copy everything except bin/
    for (const entry of readdirSync(ortNodeSrc, { withFileTypes: true })) {
      if (entry.name === "bin") continue;
      const s = join(ortNodeSrc, entry.name);
      const d = join(ortNodeDest, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(s, d);
      } else {
        mkdirSync(ortNodeDest, { recursive: true });
        copyFileSync(s, d);
      }
    }
    // Copy all platform binaries during build (installer will prune for target)
    const binSrc = join(ortNodeSrc, "bin");
    if (existsSync(binSrc)) {
      copyDirSync(binSrc, join(ortNodeDest, "bin"));
    }
  }

  // Copy pdf.js worker
  const pdfWorker = join(__dirname, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js");
  if (existsSync(pdfWorker)) {
    copyFileSync(pdfWorker, join(outDir, "pdf.worker.min.js"));
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
  external: ["obsidian", "electron", "canvas", "./ort.all.min.js", "onnxruntime-node"],
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
