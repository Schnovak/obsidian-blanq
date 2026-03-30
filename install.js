#!/usr/bin/env node
/**
 * Blanq Worksheet — Cross-platform Obsidian Plugin Installer
 * Works on Windows, macOS, and Linux.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const readline = require("readline");

const https = require("https");

const PLUGIN_ID = "blanq-worksheet";
const SCRIPT_DIR = __dirname;
const MODEL_URL = "https://github.com/Schnovak/obsidian-blanq/releases/download/v1.0.0/FFDNet-S.onnx";

// ── Colors (ANSI, works in modern terminals + Windows Terminal) ──
const BOLD = "\x1b[1m", DIM = "\x1b[2m", NC = "\x1b[0m";
const GREEN = "\x1b[32m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m";
const RED = "\x1b[31m", MAGENTA = "\x1b[35m";

const ok   = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}!${NC} ${m}`);
const err  = (m) => console.log(`  ${RED}✗${NC} ${m}`);
const info = (m) => console.log(`  ${CYAN}▸${NC} ${m}`);
const step = (n, m) => console.log(`\n${BOLD}${MAGENTA}[${n}]${NC} ${BOLD}${m}${NC}`);

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function fileSize(p) {
  try {
    const s = fs.statSync(p).size;
    if (s > 1e6) return (s / 1e6).toFixed(1) + " MB";
    return (s / 1e3).toFixed(0) + " KB";
  } catch { return "?"; }
}

function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p)) {
      const fp = path.join(p, f);
      const st = fs.statSync(fp);
      total += st.isFile() ? st.size : 0;
    }
  } catch {}
  if (total > 1e6) return (total / 1e6).toFixed(1) + " MB";
  return (total / 1e3).toFixed(0) + " KB";
}

// ── Header ──
function header() {
  console.log();
  console.log(`${BOLD}${CYAN}  ┌──────────────────────────────────────┐${NC}`);
  console.log(`${BOLD}${CYAN}  │      Blanq Worksheet Installer       │${NC}`);
  console.log(`${BOLD}${CYAN}  │   Offline PDF blank detection for     │${NC}`);
  console.log(`${BOLD}${CYAN}  │            Obsidian                   │${NC}`);
  console.log(`${BOLD}${CYAN}  └──────────────────────────────────────┘${NC}`);
  console.log();
}

// ── Find Obsidian config files ──
function findObsidianConfigs() {
  const configs = [];
  const home = os.homedir();
  const platform = os.platform();

  if (platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const p = path.join(appdata, "obsidian", "obsidian.json");
    if (fs.existsSync(p)) configs.push(p);
  }

  if (platform === "darwin") {
    const p = path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    if (fs.existsSync(p)) configs.push(p);
  }

  if (platform === "linux") {
    // Native
    const p1 = path.join(home, ".config", "obsidian", "obsidian.json");
    if (fs.existsSync(p1)) configs.push(p1);
    // Flatpak
    const p2 = path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json");
    if (fs.existsSync(p2)) configs.push(p2);

    // WSL: check Windows side
    try {
      const mntUsers = "/mnt/c/Users";
      if (fs.existsSync(mntUsers)) {
        for (const user of fs.readdirSync(mntUsers)) {
          const p = path.join(mntUsers, user, "AppData", "Roaming", "obsidian", "obsidian.json");
          if (fs.existsSync(p)) configs.push(p);
        }
      }
    } catch {}
  }

  return configs;
}

// ── Extract vault paths from obsidian.json ──
function extractVaults(configPath) {
  const vaults = [];
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const v of Object.values(data.vaults || {})) {
      const p = v.path;
      if (p && fs.existsSync(p)) {
        vaults.push(p);
      }
    }
  } catch {}
  return vaults;
}

// ── Scan common dirs for .obsidian folders ──
function scanForVaults(knownVaults) {
  const found = [];
  const home = os.homedir();
  const searchDirs = [
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    home,
  ];

  // On WSL, also check Windows dirs
  try {
    const mntUsers = "/mnt/c/Users";
    if (fs.existsSync(mntUsers)) {
      for (const user of fs.readdirSync(mntUsers)) {
        const base = path.join(mntUsers, user);
        searchDirs.push(path.join(base, "Documents"));
        searchDirs.push(path.join(base, "Desktop"));
        searchDirs.push(path.join(base, "OneDrive"));
      }
    }
  } catch {}

  function scan(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === ".obsidian") {
          const vault = dir;
          if (!knownVaults.includes(vault) && !found.includes(vault)) {
            found.push(vault);
          }
        } else if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          scan(full, depth + 1);
        }
      }
    } catch {}
  }

  for (const d of searchDirs) {
    if (fs.existsSync(d)) scan(d, 0);
  }
  return found;
}

// ── Download file with redirect support ──
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let totalBytes = 0;
    let receivedBytes = 0;

    function follow(url) {
      https.get(url, (res) => {
        // Follow redirects (GitHub uses 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          fs.unlinkSync(dest);
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        totalBytes = parseInt(res.headers["content-length"] || "0", 10);
        res.pipe(file);
        res.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((receivedBytes / totalBytes) * 100);
            const mb = (receivedBytes / 1e6).toFixed(1);
            const totalMb = (totalBytes / 1e6).toFixed(1);
            process.stdout.write(`\r  ${CYAN}▸${NC} Downloading model... ${mb}/${totalMb} MB (${pct}%)`);
          }
        });
        file.on("finish", () => {
          file.close();
          process.stdout.write("\n");
          resolve();
        });
      }).on("error", (e) => {
        fs.unlinkSync(dest);
        reject(e);
      });
    }
    follow(url);
  });
}

// ── Check prerequisites ──
async function checkPrereqs() {
  step("1/4", "Checking prerequisites");

  let missing = false;

  // Node is obviously here since we're running
  ok(`Node.js ${process.version}`);

  // Check npm
  try {
    const npmVer = execSync("npm --version", { encoding: "utf8" }).trim();
    ok(`npm ${npmVer}`);
  } catch {
    err("npm not found");
    missing = true;
  }

  if (missing) {
    console.log();
    err("Missing prerequisites. Fix the above issues and try again.");
    process.exit(1);
  }

  // Check model — download if missing
  let modelPath = path.join(SCRIPT_DIR, "FFDNet-S.onnx");
  if (!fs.existsSync(modelPath)) {
    modelPath = path.join(SCRIPT_DIR, "..", "FFDNet-S.onnx");
  }
  if (fs.existsSync(modelPath)) {
    ok(`Model found: FFDNet-S.onnx (${fileSize(modelPath)})`);
  } else {
    modelPath = path.join(SCRIPT_DIR, "FFDNet-S.onnx");
    info("Model not found — downloading from GitHub release...");
    try {
      await download(MODEL_URL, modelPath);
      ok(`Model downloaded: FFDNet-S.onnx (${fileSize(modelPath)})`);
    } catch (e) {
      err(`Failed to download model: ${e.message}`);
      warn("You can manually download it from:");
      warn(MODEL_URL);
      process.exit(1);
    }
  }

  return modelPath;
}

// ── Build plugin ──
function buildPlugin() {
  step("2/4", "Building plugin");

  const nodeModules = path.join(SCRIPT_DIR, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    info("Installing dependencies...");
    execSync("npm install", { cwd: SCRIPT_DIR, stdio: "pipe" });
    ok("Dependencies installed");
  } else {
    ok("Dependencies already installed");
  }

  info("Building...");
  execSync("npm run build", { cwd: SCRIPT_DIR, stdio: "pipe" });

  const mainJs = path.join(SCRIPT_DIR, "main.js");
  if (!fs.existsSync(mainJs)) {
    err("Build failed — main.js not found");
    process.exit(1);
  }

  ok(`Plugin built (${fileSize(mainJs)})`);
}

// ── Select vaults ──
async function selectVaults() {
  step("3/4", "Finding Obsidian vaults");

  let allVaults = [];

  const configs = findObsidianConfigs();
  for (const cfg of configs) {
    info(`Found config: ${DIM}${cfg}${NC}`);
    allVaults.push(...extractVaults(cfg));
  }

  // Scan filesystem for additional vaults
  const scanned = scanForVaults(allVaults);
  allVaults.push(...scanned);

  // Deduplicate
  allVaults = [...new Set(allVaults.map((v) => path.resolve(v)))];

  if (allVaults.length === 0) {
    warn("No Obsidian vaults found automatically.");
    console.log();
    const manual = await ask("  Enter the path to your vault:\n  > ");
    if (fs.existsSync(manual)) {
      allVaults.push(path.resolve(manual));
    } else {
      err(`Directory not found: ${manual}`);
      process.exit(1);
    }
  }

  console.log();
  console.log(`  ${BOLD}Found ${allVaults.length} vault(s):${NC}`);
  console.log();

  for (let i = 0; i < allVaults.length; i++) {
    const vname = path.basename(allVaults[i]);
    const vpath = allVaults[i];
    const pluginDir = path.join(vpath, ".obsidian", "plugins", PLUGIN_ID);
    const status = fs.existsSync(pluginDir)
      ? ` ${DIM}(installed — will update)${NC}`
      : "";
    console.log(`    ${BOLD}${i + 1}${NC}) ${GREEN}${vname}${NC}${status}`);
    console.log(`       ${DIM}${vpath}${NC}`);
  }

  console.log();
  console.log(`  ${BOLD}Select vaults to install to:${NC}`);
  console.log(`  ${DIM}Enter numbers separated by spaces, 'a' for all, or 'q' to quit${NC}`);
  const selection = await ask("  > ");

  if (selection.toLowerCase() === "q") {
    info("Cancelled.");
    process.exit(0);
  }

  let selected;
  if (selection.toLowerCase() === "a") {
    selected = [...allVaults];
  } else {
    selected = [];
    for (const s of selection.split(/\s+/)) {
      const idx = parseInt(s, 10) - 1;
      if (idx >= 0 && idx < allVaults.length) {
        selected.push(allVaults[idx]);
      } else {
        warn(`Skipping invalid selection: ${s}`);
      }
    }
  }

  if (selected.length === 0) {
    err("No vaults selected.");
    process.exit(1);
  }

  ok(`Selected ${selected.length} vault(s)`);
  return selected;
}

// ── Install to vaults ──
function installToVaults(vaults, modelPath) {
  step("4/4", "Installing plugin");

  // Collect files to copy
  const filesToCopy = ["main.js", "manifest.json"];

  for (const f of fs.readdirSync(SCRIPT_DIR)) {
    if (f.endsWith(".wasm") || f.endsWith(".mjs") || f === "ort.all.min.js" || f === "pdf.worker.min.js") {
      filesToCopy.push(f);
    }
  }

  for (const vault of vaults) {
    const vname = path.basename(vault);
    const dest = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);

    info(`Installing to ${BOLD}${vname}${NC}...`);
    fs.mkdirSync(dest, { recursive: true });

    for (const f of filesToCopy) {
      const src = path.join(SCRIPT_DIR, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dest, f));
      }
    }

    // Copy model
    fs.copyFileSync(modelPath, path.join(dest, "FFDNet-S.onnx"));

    // Copy node_modules (onnxruntime-node + onnxruntime-common)
    const nmSrc = path.join(SCRIPT_DIR, "node_modules");
    const nmDest = path.join(dest, "node_modules");
    for (const pkg of ["onnxruntime-node", "onnxruntime-common"]) {
      const pkgSrc = path.join(nmSrc, pkg);
      if (fs.existsSync(pkgSrc)) {
        copyDirRecursive(pkgSrc, path.join(nmDest, pkg));
      }
    }

    ok(`Installed to ${vname} (${dirSize(dest)})`);
  }
}

// ── Next steps ──
function showNextSteps() {
  console.log();
  console.log(`${BOLD}${CYAN}  ┌──────────────────────────────────────┐${NC}`);
  console.log(`${BOLD}${CYAN}  │        Installation Complete!         │${NC}`);
  console.log(`${BOLD}${CYAN}  └──────────────────────────────────────┘${NC}`);
  console.log();
  console.log(`  ${BOLD}Next steps:${NC}`);
  console.log();
  console.log(`    ${BOLD}1.${NC} Open Obsidian`);
  console.log(`    ${BOLD}2.${NC} Go to ${CYAN}Settings → Community Plugins${NC}`);
  console.log(`    ${BOLD}3.${NC} Make sure ${CYAN}Restricted mode${NC} is ${YELLOW}turned off${NC}`);
  console.log(`    ${BOLD}4.${NC} Find ${GREEN}Blanq Worksheet${NC} in the installed plugins`);
  console.log(`    ${BOLD}5.${NC} Click the ${CYAN}toggle${NC} to enable it`);
  console.log();
  console.log(`  ${BOLD}Usage:${NC}`);
  console.log();
  console.log(`    ${GREEN}•${NC} Click any PDF in your vault → opens in Blanq`);
  console.log(`    ${GREEN}•${NC} Right-click a PDF → ${CYAN}Open in Blanq${NC}`);
  console.log(`    ${GREEN}•${NC} Command palette → ${CYAN}Open Blanq Worksheet${NC}`);
  console.log(`    ${GREEN}•${NC} Click detected blanks to type answers`);
  console.log(`    ${GREEN}•${NC} Click ${CYAN}Save${NC} to write answers into the PDF`);
  console.log();
  console.log(`  ${BOLD}Optional — AI Fill:${NC}`);
  console.log();
  console.log(`    ${GREEN}•${NC} Settings → Blanq Worksheet → add API key`);
  console.log(`    ${GREEN}•${NC} Click ${CYAN}AI Fill${NC} to auto-fill worksheet answers`);
  console.log();
  console.log(`  ${DIM}Blank detection works fully offline — no internet needed.${NC}`);
  console.log(`  ${DIM}AI Fill is optional and requires an API key + internet.${NC}`);
  console.log();
}

// ── Main ──
async function main() {
  header();
  const modelPath = await checkPrereqs();
  buildPlugin();
  const vaults = await selectVaults();
  installToVaults(vaults, modelPath);
  showNextSteps();
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
