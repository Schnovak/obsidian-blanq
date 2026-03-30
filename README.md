# Blanq Worksheet — Obsidian Plugin

Detect blank fields in PDF worksheets and fill them in — **fully offline** using a local ONNX model. No server required.

## Features

- **Offline blank detection** — Uses a YOLO ONNX model running locally via WebAssembly. No internet needed.
- **Click to fill** — Detected blanks become editable text fields overlaid on the PDF.
- **Add blanks manually** — Click "Add Blank" then click any bordered area on the PDF.
- **Tab navigation** — Tab/Shift+Tab to jump between blanks in reading order.
- **AI Fill (optional)** — If you have an Anthropic or OpenAI API key, automatically fill in answers. Requires internet.
- **Save in place** — Save filled answers directly into the original PDF.
- **Click-to-open** — Clicking any PDF in Obsidian's file explorer opens it in Blanq.

## Quick Install

Run this single command (works on Windows, macOS, and Linux — run it as many times as you want):

```
node -e "const{execSync:r}=require('child_process'),f=require('fs');f.existsSync('obsidian-blanq')?r('git checkout . && git pull',{cwd:'obsidian-blanq',stdio:'inherit'}):r('git clone https://github.com/Schnovak/obsidian-blanq.git',{stdio:'inherit'});r('node install.js',{cwd:'obsidian-blanq',stdio:'inherit'})"
```

The installer will:
1. Check prerequisites (Node.js, npm, model file)
2. Build the plugin
3. Find all Obsidian vaults on your system
4. Let you choose which vaults to install to
5. Copy all necessary files and show next steps

> **Note:** You need `FFDNet-S.onnx` in the repo directory or its parent. The installer will find it automatically.

## Manual Installation

1. Clone or download this repo:
   ```bash
   git clone https://github.com/Schnovak/obsidian-blanq.git
   cd obsidian-blanq
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Copy these files to `<your-vault>/.obsidian/plugins/blanq-worksheet/`:
   - `main.js`
   - `manifest.json`
   - `FFDNet-S.onnx` (detection model, ~37 MB)
   - All `*.wasm` and `*.mjs` files (ONNX Runtime WASM fallback)
   - `ort.all.min.js`
   - `pdf.worker.min.js`
   - `node_modules/` directory (contains `onnxruntime-node` and `onnxruntime-common` for fast native inference)

4. In Obsidian: **Settings → Community Plugins → Turn off Restricted Mode → Enable Blanq Worksheet**

## Usage

1. **Open a PDF** — Click any PDF in the file explorer, or use the command palette ("Open Blanq Worksheet").
2. **Fill in blanks** — Click on detected blank fields and type your answers.
3. **Add blanks manually** — Click "+ Add Blank" in the toolbar, then click a bordered area on the PDF.
4. **AI Fill** (optional) — Configure an API key in Settings, then click "AI Fill" to auto-fill answers.
5. **Save** — Click "Save" to write your answers into the original PDF.

## Settings

| Setting | Description |
|---------|-------------|
| AI Provider | Anthropic (Claude) or OpenAI (GPT-4o) |
| API Key | Your API key for AI Fill. Leave empty for offline-only mode. |

## Development

```bash
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

## How it works

The plugin uses a fine-tuned YOLO11s model (`FFDNet-S.onnx`) to detect text input fields, choice buttons, and other blank regions in worksheet PDFs. The model runs locally using ONNX Runtime Node (native, fast) with a WebAssembly fallback — no server or GPU required.

Detected regions are overlaid with editable text areas. When saving, answers are embedded into the PDF using pdf-lib.
