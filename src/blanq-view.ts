/**
 * BlanqView — Obsidian ItemView that renders a PDF, detects blanks, and lets users fill them.
 */
import { ItemView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import { detectBlanks, findEnclosingBox, disposeModel, type BlankBox } from "./detection";
import type BlanqPlugin from "./main";

export const VIEW_TYPE_BLANQ = "blanq-worksheet-view";

export class BlanqView extends ItemView {
  plugin: BlanqPlugin;
  private pdfFile: TFile | null = null;
  private pdfBytes: Uint8Array | null = null;
  private blanks: BlankBox[] = [];
  private pageTexts: Record<number, string> = {};
  private addBlankMode = false;

  constructor(leaf: WorkspaceLeaf, plugin: BlanqPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BLANQ;
  }

  getDisplayText(): string {
    return this.pdfFile ? `Blanq: ${this.pdfFile.name}` : "Blanq Worksheet";
  }

  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("blanq-container");
    this.buildUI(container);
  }

  async onClose(): Promise<void> {
    disposeModel();
  }

  private buildUI(container: HTMLElement): void {
    // Inject styles
    const style = container.createEl("style");
    style.textContent = BLANQ_CSS;

    // Toolbar
    const toolbar = container.createDiv({ cls: "blanq-toolbar" });

    const openBtn = toolbar.createEl("button", {
      text: "Open PDF",
      cls: "blanq-btn",
    });
    openBtn.addEventListener("click", () => this.pickFile());

    const addBlankBtn = toolbar.createEl("button", {
      text: "+ Add Blank",
      cls: "blanq-btn blanq-btn-ghost",
    });
    addBlankBtn.addEventListener("click", () => {
      this.addBlankMode = !this.addBlankMode;
      addBlankBtn.classList.toggle("active", this.addBlankMode);
      viewer.classList.toggle("blanq-add-mode", this.addBlankMode);
    });

    const fontSel = toolbar.createEl("select", { cls: "blanq-select" });
    fontSel.createEl("option", { text: "Kalam", value: "kalam" });
    fontSel.createEl("option", { text: "JetBrains Mono", value: "jetbrains" });
    fontSel.addEventListener("change", () => {
      const ff =
        fontSel.value === "jetbrains" ? "JetBrains Mono" : "Kalam";
      container
        .querySelectorAll<HTMLTextAreaElement>(".blanq-overlay-input")
        .forEach((ta) => (ta.style.fontFamily = ff + ",cursive"));
    });

    // AI Fill button (only works with API key in settings)
    const aiBtn = toolbar.createEl("button", {
      text: "AI Fill",
      cls: "blanq-btn blanq-btn-ai",
    });
    aiBtn.disabled = true;
    aiBtn.addEventListener("click", () => this.aiFill(aiBtn));

    const exportBtn = toolbar.createEl("button", {
      text: "Save",
      cls: "blanq-btn blanq-btn-dl",
    });
    exportBtn.style.display = "none";
    exportBtn.addEventListener("click", () => this.exportPdf(fontSel.value));

    // Status log
    const log = container.createDiv({ cls: "blanq-log" });

    // PDF viewer area
    const viewer = container.createDiv({ cls: "blanq-viewer" });

    // Drop zone
    const dropZone = viewer.createDiv({ cls: "blanq-drop" });
    dropZone.createDiv({ text: "Drop a PDF here or click Open PDF" });

    // Store refs
    this._refs = { toolbar, viewer, log, exportBtn, aiBtn, addBlankBtn, fontSel, dropZone };

    // Keyboard shortcuts
    this.registerDomEvent(container, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (this.addBlankMode) {
          this.addBlankMode = false;
          addBlankBtn.classList.remove("active");
          viewer.classList.remove("blanq-add-mode");
        }
      }
      if (e.key === "Tab" && !e.altKey) {
        const inputs = [
          ...container.querySelectorAll<HTMLTextAreaElement>(".blanq-overlay-input"),
        ];
        if (!inputs.length) return;
        const active = document.activeElement as HTMLElement;
        if (
          active &&
          !active.classList.contains("blanq-overlay-input") &&
          (active.tagName === "INPUT" || active.tagName === "SELECT")
        )
          return;
        inputs.sort((a, b) => {
          const ay = parseFloat(a.style.top) || 0,
            by = parseFloat(b.style.top) || 0;
          if (Math.abs(ay - by) > 5) return ay - by;
          return (parseFloat(a.style.left) || 0) - (parseFloat(b.style.left) || 0);
        });
        e.preventDefault();
        const cur = inputs.indexOf(document.activeElement as HTMLTextAreaElement);
        const next = e.shiftKey
          ? (cur <= 0 ? inputs.length - 1 : cur - 1)
          : (cur >= inputs.length - 1 ? 0 : cur + 1);
        inputs[next].focus();
      }
    });
  }

  private _refs!: {
    toolbar: HTMLElement;
    viewer: HTMLElement;
    log: HTMLElement;
    exportBtn: HTMLElement;
    aiBtn: HTMLButtonElement;
    addBlankBtn: HTMLElement;
    fontSel: HTMLSelectElement;
    dropZone: HTMLElement;
  };

  private log(msg: string, level: "info" | "ok" | "warn" | "err" = "info"): void {
    const t = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const d = this._refs.log.createDiv({ cls: `blanq-ll ${level}` });
    d.innerHTML = `<span class="blanq-ts">[${t}]</span> ${msg}`;
    this._refs.log.scrollTop = 1e9;
  }

  async loadPdf(file: TFile): Promise<void> {
    this.pdfFile = file;
    this.leaf.updateHeader();
    const data = await this.app.vault.readBinary(file);
    this.pdfBytes = new Uint8Array(data);
    await this.analyze();
  }

  private async pickFile(): Promise<void> {
    // Find all PDFs in vault
    const pdfs = this.app.vault.getFiles().filter((f) => f.extension === "pdf");
    if (!pdfs.length) {
      new Notice("No PDF files found in vault");
      return;
    }

    // Use a simple modal picker
    const { FuzzySuggestModal } = await import("obsidian");

    class PdfPicker extends FuzzySuggestModal<TFile> {
      onChoose: (file: TFile) => void;
      constructor(app: any, onChoose: (f: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
      }
      getItems(): TFile[] {
        return pdfs;
      }
      getItemText(item: TFile): string {
        return item.path;
      }
      onChooseItem(item: TFile): void {
        this.onChoose(item);
      }
    }

    new PdfPicker(this.app, (f) => this.loadPdf(f)).open();
  }

  private async analyze(): Promise<void> {
    if (!this.pdfBytes) return;
    const { viewer, exportBtn, aiBtn, dropZone } = this._refs;

    viewer.empty();
    this._refs.log.empty();
    this.blanks = [];
    this.pageTexts = {};
    exportBtn.style.display = "none";

    try {

    this.log("Loading PDF...");
    console.log("[Blanq] Starting PDF analysis...");

    // Dynamic import of pdfjs
    console.log("[Blanq] Importing pdfjs-dist...");
    const pdfjsLib = await import("pdfjs-dist");
    // Load worker source as a blob URL (file:// is blocked in Obsidian)
    const fs = require("fs");
    const workerPath = require("path").join(
      this.plugin.getPluginDir(), "pdf.worker.min.js"
    );
    console.log(`[Blanq] Reading worker from: ${workerPath}`);
    const workerCode = fs.readFileSync(workerPath, "utf8");
    const blob = new Blob([workerCode], { type: "application/javascript" });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    console.log("[Blanq] pdfjs loaded, worker blob created");

    this.log("Parsing PDF...");
    console.log("[Blanq] Calling getDocument...");
    const pdf = await pdfjsLib.getDocument({ data: this.pdfBytes.slice() }).promise;
    const numPages = pdf.numPages;
    console.log(`[Blanq] PDF loaded: ${numPages} pages`);
    this.log(`${numPages} page(s) loaded`, "ok");

    const containerW = viewer.clientWidth || 800;
    const fontFamily =
      this._refs.fontSel.value === "jetbrains" ? "JetBrains Mono" : "Kalam";

    let allBlanks: BlankBox[] = [];

    const modelPath = this.plugin.getModelPath();
    const pluginDir = this.plugin.getPluginDir();
    console.log(`[Blanq] Model path: ${modelPath}`);
    console.log(`[Blanq] Plugin dir: ${pluginDir}`);

    for (let p = 1; p <= numPages; p++) {
      console.log(`[Blanq] Processing page ${p}/${numPages}...`);
      const page = await pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });

      // Extract text
      console.log(`[Blanq] Page ${p}: extracting text...`);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it: any) => it.str != null)
        .map((it: any) => {
          const tx = it.transform;
          return { str: it.str, x: tx[4], y: tx[5] };
        });
      const sorted = [...items].sort(
        (a: any, b: any) => b.y - a.y || a.x - b.x
      );
      this.pageTexts[p] = sorted
        .map((it: any) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      // Render page
      console.log(`[Blanq] Page ${p}: rendering canvas...`);
      const displayScale = containerW / vp1.width;
      const vp = page.getViewport({ scale: displayScale });
      const dpr = window.devicePixelRatio || 1;

      const wrap = viewer.createDiv({ cls: "blanq-pdf-page" });
      wrap.style.width = vp.width + "px";
      wrap.style.height = vp.height + "px";

      const canvas = wrap.createEl("canvas");
      canvas.width = Math.round(vp.width * dpr);
      canvas.height = Math.round(vp.height * dpr);
      canvas.style.width = vp.width + "px";
      canvas.style.height = vp.height + "px";

      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      console.log(`[Blanq] Page ${p}: rendered (${canvas.width}x${canvas.height})`);

      // Click to add blank
      const pg = p;
      wrap.addEventListener("click", (e) =>
        this.handleAddBlankClick(e, wrap, canvas, pg)
      );

      // Detect blanks
      this.log(`Detecting blanks on page ${p}...`);
      console.log(`[Blanq] Page ${p}: running detection model...`);
      let pageBlanks: BlankBox[];
      try {
        pageBlanks = await detectBlanks(canvas, p, modelPath, pluginDir);
        console.log(`[Blanq] Page ${p}: detected ${pageBlanks.length} blanks`);
      } catch (err: any) {
        console.error(`[Blanq] Page ${p}: detection failed:`, err);
        this.log(`Detection error: ${err.message}`, "err");
        pageBlanks = [];
      }
      this.log(`${pageBlanks.length} blank(s) found on page ${p}`, "ok");

      pageBlanks.sort((a, b) => a.y - b.y || a.x - b.x);

      // Create overlays
      for (const b of pageBlanks) {
        const ox = b.x / dpr,
          oy = b.y / dpr,
          ow = b.width / dpr,
          oh = b.height / dpr;
        const ta = this.createOverlayInput(wrap, b, ox, oy, ow, oh, fontFamily, dpr);
        ta.placeholder = "#" + (allBlanks.length + pageBlanks.indexOf(b) + 1);

        // Store display info for export
        b.vw = vp1.width;
        b.vh = vp1.height;
        b.displayScale = displayScale;
        b.dpr = dpr;
      }

      allBlanks.push(...pageBlanks);
    }

    allBlanks.forEach((b, i) => (b.id = i + 1));
    this.blanks = allBlanks;

    // Renumber
    viewer
      .querySelectorAll<HTMLTextAreaElement>(".blanq-overlay-input")
      .forEach((ta, i) => {
        ta.placeholder = "#" + (i + 1);
        ta.id = "blanq-ans-" + (i + 1);
      });

    if (!allBlanks.length) {
      this.log("No blanks found.", "err");
      return;
    }

    this.log(`${allBlanks.length} answer region(s) found`, "ok");
    exportBtn.style.display = "";
    aiBtn.disabled = !this.plugin.settings.apiKey;
    this.log("Ready — click blanks to type, or use AI Fill.", "ok");
    console.log(`[Blanq] Done! ${allBlanks.length} blanks total`);

    } catch (err: any) {
      console.error("[Blanq] analyze() failed:", err);
      this.log(`Error: ${err.message}`, "err");
    }
  }

  private createOverlayInput(
    wrap: HTMLElement,
    b: BlankBox,
    ox: number,
    oy: number,
    ow: number,
    oh: number,
    fontFamily: string,
    dpr: number
  ): HTMLTextAreaElement {
    const ta = wrap.createEl("textarea", { cls: "blanq-overlay-input" });
    ta.style.left = ox + "px";
    ta.style.top = oy + "px";
    ta.style.width = ow + "px";
    ta.style.height = oh + "px";
    ta.style.fontFamily = fontFamily + ",cursive";

    if (b.lineHeightPx) {
      const lh = b.lineHeightPx / dpr;
      const fs = Math.min(lh * 0.7, 16);
      ta.style.fontSize = fs + "px";
      ta.style.lineHeight = lh + "px";
      ta.style.paddingTop = "0px";
    } else if (b.mergedHeights && b.mergedHeights.length > 1) {
      const sorted = [...b.mergedHeights].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const lineCount = sorted.filter((h) => h < median * 2).length;
      const lines = Math.max(lineCount, 1);
      const lh = oh / lines;
      const fs = Math.min(lh * 0.7, 18);
      ta.style.fontSize = fs + "px";
      ta.style.lineHeight = lh + "px";
      ta.style.paddingTop = "0px";
    } else {
      const maxFs = 18;
      const fontSize = Math.min(oh * 0.7, maxFs);
      const naturalLh = fontSize * 1.4;
      if (oh > naturalLh * 1.5) {
        ta.style.fontSize = Math.min(maxFs, fontSize) + "px";
        ta.style.lineHeight = naturalLh + "px";
        ta.style.paddingTop = Math.round(naturalLh * 0.15) + "px";
      } else {
        ta.style.fontSize = fontSize + "px";
        ta.style.lineHeight = oh + "px";
      }
    }

    const origFs = parseFloat(ta.style.fontSize);
    const origLh = parseFloat(ta.style.lineHeight);
    ta.dataset.origFs = String(origFs);
    ta.dataset.origLh = String(origLh);

    ta.addEventListener("input", () => {
      b.answer = ta.value;
      ta.classList.toggle("filled", !!ta.value.trim());
      this.fitText(ta, oh);
    });

    return ta;
  }

  private fitText(ta: HTMLTextAreaElement, boxH: number): void {
    const origFs = parseFloat(ta.dataset.origFs!);
    const origLh = parseFloat(ta.dataset.origLh!);
    const lhRatio = origLh / origFs;
    let curFs = parseFloat(ta.style.fontSize);

    function applySize(fs: number) {
      ta.style.fontSize = fs + "px";
      ta.style.lineHeight = fs * lhRatio + "px";
    }

    if (curFs < origFs) {
      applySize(origFs);
      if (ta.scrollHeight <= ta.clientHeight + 1) {
        curFs = origFs;
      } else {
        applySize(curFs);
        while (curFs < origFs - 0.3) {
          const tryFs = Math.min(curFs + 0.5, origFs);
          applySize(tryFs);
          if (ta.scrollHeight > ta.clientHeight + 1) {
            applySize(curFs);
            break;
          }
          curFs = tryFs;
        }
      }
    }

    while (ta.scrollHeight > ta.clientHeight + 1 && curFs > 5) {
      curFs = Math.max(curFs - 0.5, 5);
      applySize(curFs);
    }
  }

  private handleAddBlankClick(
    e: MouseEvent,
    wrap: HTMLElement,
    canvas: HTMLCanvasElement,
    pageNum: number
  ): void {
    if (!this.addBlankMode) return;
    if ((e.target as HTMLElement).classList.contains("blanq-overlay-input"))
      return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = Math.round((e.clientX - rect.left) * dpr);
    const cy = Math.round((e.clientY - rect.top) * dpr);
    const box = findEnclosingBox(canvas, cx, cy);

    if (!box) {
      this.log("No enclosing box found at click position", "warn");
      return;
    }

    const margin = Math.round(Math.min(box.width, box.height) * 0.06);
    box.x += margin;
    box.y += margin;
    box.width -= margin * 2;
    box.height -= margin * 2;
    if (box.width < 10 || box.height < 10) return;

    const fontFamily =
      this._refs.fontSel.value === "jetbrains" ? "JetBrains Mono" : "Kalam";
    const b: BlankBox = {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      confidence: 1.0,
      page: pageNum,
      canvasW: canvas.width,
      canvasH: canvas.height,
      answer: "",
      type: "Manual",
      mergedHeights: [box.height],
    };

    this.blanks.push(b);
    const ox = b.x / dpr,
      oy = b.y / dpr,
      ow = b.width / dpr,
      oh = b.height / dpr;
    const ta = this.createOverlayInput(wrap, b, ox, oy, ow, oh, fontFamily, dpr);
    ta.focus();

    // Renumber
    this.blanks.forEach((bl, i) => (bl.id = i + 1));
    this._refs.viewer
      .querySelectorAll<HTMLTextAreaElement>(".blanq-overlay-input")
      .forEach((el, i) => {
        el.placeholder = "#" + (i + 1);
        el.id = "blanq-ans-" + (i + 1);
      });

    this.log(`Added blank #${this.blanks.length}`, "ok");
    this.addBlankMode = false;
    this._refs.addBlankBtn.classList.remove("active");
    this._refs.viewer.classList.remove("blanq-add-mode");
    this._refs.exportBtn.style.display = "";
    this._refs.aiBtn.disabled = !this.plugin.settings.apiKey;
  }

  // ── AI Fill ──
  private async aiFill(btn: HTMLButtonElement): Promise<void> {
    const { apiKey, apiProvider } = this.plugin.settings;
    if (!apiKey || !this.blanks.length) return;

    btn.disabled = true;
    btn.textContent = "Filling...";

    try {
      this.log("Calling AI...", "info");
      const prompt = this.buildPrompt();
      const text =
        apiProvider === "openai"
          ? await this.callOpenAI(apiKey, prompt)
          : await this.callAnthropic(apiKey, prompt);

      const jsonStr = text
        .replace(/^```json?\s*/, "")
        .replace(/\s*```$/, "")
        .trim();
      const answers = JSON.parse(jsonStr);
      let filled = 0;
      for (const a of answers) {
        const blank = this.blanks.find((b) => b.id === a.id);
        if (blank && a.answer) {
          blank.answer = a.answer;
          const ta = this._refs.viewer.querySelector<HTMLTextAreaElement>(
            `#blanq-ans-${a.id}`
          );
          if (ta) {
            ta.value = a.answer;
            ta.classList.add("filled");
          }
          filled++;
        }
      }
      this.log(`AI filled ${filled}/${this.blanks.length} answers`, "ok");
    } catch (err: any) {
      this.log(`AI error: ${err.message}`, "err");
    } finally {
      btn.textContent = "AI Fill";
      btn.disabled = !this.plugin.settings.apiKey;
    }
  }

  private buildPrompt(): string {
    const pages = new Set(this.blanks.map((b) => b.page));
    let ctx = "";
    for (const p of pages)
      ctx += `--- Page ${p} ---\n${this.pageTexts[p] || "(no text)"}\n\n`;

    const blanksDesc = this.blanks
      .map((b) => {
        const charEst = Math.round(b.width / ((b.displayScale || 1) * 6.5));
        const lineEst =
          b.lineCount ||
          Math.max(1, Math.round(b.height / ((b.displayScale || 1) * 16)));
        const type = b.lineCount ? "long answer field" : "inline blank";
        return `#${b.id} (p.${b.page}, ${type}, ~${charEst * lineEst} chars, ${lineEst} line(s), position: ${Math.round(
          (b.x / b.canvasW) * 100
        )}% from left, ${Math.round((b.y / b.canvasH) * 100)}% from top)`;
      })
      .join("\n");

    return `You are a student filling in a worksheet. The worksheet text and detected blank regions are below. Figure out which blank belongs to which question based on position and context. Write natural, complete answers in the worksheet's language.\n\nWORKSHEET TEXT:\n${ctx}\nDETECTED BLANKS:\n${blanksDesc}\n\nRespond ONLY with JSON: [{"id": 1, "answer": "..."}, ...]`;
  }

  private async callAnthropic(key: string, prompt: string): Promise<string> {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
      throw new Error(`API ${resp.status}: ${e.error?.message || resp.statusText}`);
    }
    const d = await resp.json();
    return d.content?.find((b: any) => b.type === "text")?.text || "";
  }

  private async callOpenAI(key: string, prompt: string): Promise<string> {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
      throw new Error(
        `API ${resp.status}: ${e.error?.message || (e as any).message || resp.statusText}`
      );
    }
    const d = await resp.json();
    return d.choices?.[0]?.message?.content || "";
  }

  // ── PDF Export ──
  async exportPdf(fontChoice: string): Promise<void> {
    if (!this.pdfBytes || !this.blanks.length) return;

    try {
      this.log("Preparing export...", "info");
      const { PDFDocument, rgb } = await import("pdf-lib");
      const fontkit = (await import("@pdf-lib/fontkit")).default;

      const doc = await PDFDocument.load(this.pdfBytes);
      doc.registerFontkit(fontkit);

      // Load font from CDN (requires network, but only for export)
      const fontUrls: Record<string, string> = {
        kalam:
          "https://cdn.jsdelivr.net/fontsource/fonts/kalam@latest/latin-400-normal.ttf",
        jetbrains:
          "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf",
      };
      const fontBytes = await fetch(fontUrls[fontChoice]).then((r) =>
        r.arrayBuffer()
      );
      const handFont = await doc.embedFont(fontBytes, { subset: false });
      const pages = doc.getPages();
      const ansTextC = rgb(0.1, 0.1, 0.35);

      function wrapLine(
        line: string,
        font: any,
        size: number,
        maxWidth: number
      ): string[] {
        const words = line.split(/\s+/);
        const wrapped: string[] = [];
        let cur = "";
        for (const w of words) {
          let word = w;
          while (
            font.widthOfTextAtSize(word, size) > maxWidth &&
            word.length > 1
          ) {
            let cut = word.length - 1;
            while (
              cut > 1 &&
              font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth
            )
              cut--;
            if (cur) {
              wrapped.push(cur);
              cur = "";
            }
            wrapped.push(word.slice(0, cut));
            word = word.slice(cut);
          }
          const test = cur ? cur + " " + word : word;
          if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
            wrapped.push(cur);
            cur = word;
          } else cur = test;
        }
        if (cur) wrapped.push(cur);
        return wrapped.length ? wrapped : [""];
      }

      for (const b of this.blanks) {
        const ansText = b.answer?.trim();
        if (!ansText) continue;
        const pg = pages[b.page - 1];
        const pgW = pg.getWidth(),
          pgH = pg.getHeight();
        const sx = pgW / b.canvasW,
          sy = pgH / b.canvasH;
        const pdfX = b.x * sx;
        const pdfY = pgH - (b.y + b.height) * sy;
        const pdfW = b.width * sx;
        const pdfH = b.height * sy;

        const nLines =
          b.lineCount || Math.max(1, Math.round(pdfH / 14));
        const lineH = b.lineHeightPx
          ? (b.lineHeightPx * sy) / (b.dpr || 1)
          : pdfH / nLines;
        let fs = Math.min(lineH * 0.7, 14);

        const ansLines = ansText.split("\n");
        let allWrapped: string[] = [];
        while (fs >= 5) {
          allWrapped = [];
          for (const line of ansLines)
            allWrapped.push(...wrapLine(line, handFont, fs, pdfW - 4));
          if (allWrapped.length <= nLines) break;
          fs -= 1;
        }
        if (allWrapped.length > nLines)
          allWrapped = allWrapped.slice(0, nLines);

        for (let k = 0; k < allWrapped.length; k++) {
          let safeText = "";
          for (const ch of allWrapped[k]) {
            try {
              handFont.widthOfTextAtSize(ch, fs);
              safeText += ch;
            } catch {
              safeText += "?";
            }
          }
          pg.drawText(safeText, {
            x: pdfX + 2,
            y: pdfY + pdfH - lineH * (k + 1) + lineH * 0.2,
            size: fs,
            font: handFont,
            color: ansTextC,
          });
        }
      }

      const out = await doc.save();

      // Overwrite the original PDF
      if (this.pdfFile) {
        await this.app.vault.modifyBinary(this.pdfFile, out);
        // Update our local copy so further edits build on the saved version
        this.pdfBytes = new Uint8Array(out);
        this.log(`Saved to ${this.pdfFile.path}`, "ok");
        new Notice(`Blanq: Saved ${this.pdfFile.name}`);
      } else {
        // No source file (shouldn't happen), save as new
        const path = "blanq-filled.pdf";
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, out);
        } else {
          await this.app.vault.createBinary(path, out);
        }
        this.log(`Saved to ${path}`, "ok");
        new Notice(`Blanq: Saved to ${path}`);
      }
    } catch (err: any) {
      this.log(`Export error: ${err.message}`, "err");
    }
  }
}

const BLANQ_CSS = `
.blanq-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.blanq-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.blanq-btn {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: var(--interactive-normal);
  color: var(--text-normal);
  transition: background 0.15s;
}
.blanq-btn:hover { background: var(--interactive-hover); }
.blanq-btn-ghost { background: transparent; }
.blanq-btn-ghost.active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: var(--interactive-accent);
}
.blanq-btn-ai {
  background: #22c55e;
  color: #000;
  border-color: #22c55e;
}
.blanq-btn-ai:hover { background: #4ade80; }
.blanq-btn-ai:disabled { opacity: 0.3; cursor: not-allowed; }
.blanq-btn-dl {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: var(--interactive-accent);
}
.blanq-btn-dl:hover { opacity: 0.9; }
.blanq-select {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--background-modifier-border);
  background: var(--interactive-normal);
  color: var(--text-normal);
}
.blanq-log {
  max-height: 100px;
  overflow-y: auto;
  padding: 4px 12px;
  font-size: 11px;
  font-family: var(--font-monospace);
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}
.blanq-ll { padding: 1px 0; color: var(--text-muted); }
.blanq-ll.ok { color: #22c55e; }
.blanq-ll.warn { color: #f59e0b; }
.blanq-ll.err { color: #ef4444; }
.blanq-ts { color: var(--text-faint); margin-right: 6px; }
.blanq-viewer {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.blanq-drop {
  border: 2px dashed var(--background-modifier-border);
  border-radius: 8px;
  padding: 48px 20px;
  text-align: center;
  color: var(--text-muted);
  width: 100%;
}
.blanq-pdf-page {
  position: relative;
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}
.blanq-pdf-page canvas {
  display: block;
}
.blanq-add-mode .blanq-pdf-page { cursor: crosshair; }
.blanq-overlay-input {
  position: absolute;
  background: rgba(99,102,241,0.08);
  border: 1.5px solid rgba(99,102,241,0.25);
  border-radius: 3px;
  color: #1a1a4e;
  padding: 1px 4px;
  resize: none;
  overflow: hidden;
  outline: none;
  box-sizing: border-box;
  font-size: 14px;
  transition: border-color 0.15s, background 0.15s;
}
.blanq-overlay-input:focus {
  border-color: rgba(99,102,241,0.6);
  background: rgba(99,102,241,0.12);
  box-shadow: 0 0 0 2px rgba(99,102,241,0.15);
}
.blanq-overlay-input.filled {
  background: rgba(34,197,94,0.08);
  border-color: rgba(34,197,94,0.3);
}
.blanq-overlay-input::placeholder {
  color: rgba(99,102,241,0.4);
  font-size: 10px;
}
`;
