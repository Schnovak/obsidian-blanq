# Blanq Worksheet — Obsidian Plugin

Detect blank fields in PDF worksheets and fill them in — **fully offline** using a local ONNX model. No server required.

## Features

- **Offline blank detection** — Uses a YOLO ONNX model running locally via WebAssembly. No internet needed.
- **Click to fill** — Detected blanks become editable text fields overlaid on the PDF.
- **Add blanks manually** — Click "Add Blank" then click any bordered area on the PDF.
- **Tab navigation** — Tab/Shift+Tab to jump between blanks in reading order.
- **AI Fill (optional)** — If you have an Anthropic or OpenAI API key, automatically fill in answers. Requires internet.
- **PDF export** — Export the filled worksheet as a new PDF saved to your vault.
- **Click-to-open** — Clicking any PDF in Obsidian's file explorer opens it in Blanq.

## Installation

### Manual install

1. Clone or download this repo into your vault's plugin folder:
   ```
   <your-vault>/.obsidian/plugins/blanq-worksheet/
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Copy the ONNX model into the plugin folder:
   ```bash
   cp /path/to/FFDNet-S.onnx <your-vault>/.obsidian/plugins/blanq-worksheet/
   ```

4. In Obsidian, go to **Settings → Community Plugins** and enable **Blanq Worksheet**.

### Required files in the plugin folder

After building, your plugin folder should contain:
- `main.js` — Plugin code
- `manifest.json` — Plugin metadata
- `FFDNet-S.onnx` — Detection model (~37 MB)
- `ort-wasm-simd-threaded.wasm` — ONNX Runtime WASM (~12 MB)
- Other `.wasm` / `.mjs` files — ONNX Runtime support files

## Usage

1. **Open a PDF** — Click any PDF in the file explorer, or use the ribbon icon / command palette ("Open Blanq Worksheet").
2. **Fill in blanks** — Click on detected blank fields and type your answers.
3. **Add blanks manually** — Click "+ Add Blank" in the toolbar, then click a bordered area on the PDF.
4. **AI Fill** (optional) — Configure an API key in Settings, then click "AI Fill" to auto-fill answers.
5. **Export** — Click "Export PDF" to save the filled worksheet to your vault.

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

The plugin uses a fine-tuned YOLO11s model (`FFDNet-S.onnx`) to detect text input fields, choice buttons, and other blank regions in worksheet PDFs. The model runs entirely in the browser via ONNX Runtime Web (WebAssembly) — no server or GPU required.

Detected regions are overlaid with editable text areas. When exporting, answers are embedded into the PDF using pdf-lib.
