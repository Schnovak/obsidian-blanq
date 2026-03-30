/**
 * BlanqView — Obsidian FileView that renders a PDF, detects blanks, and lets users fill them.
 */
import { FileView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import { detectBlanks, findEnclosingBox, disposeModel, type BlankBox } from "./detection";
import type BlanqPlugin from "./main";

export const VIEW_TYPE_BLANQ = "blanq-worksheet-view";

export class BlanqView extends FileView {
  plugin: BlanqPlugin;
  private pdfBytes: Uint8Array | null = null;
  private blanks: BlankBox[] = [];
  private pageTexts: Record<number, string> = {};
  private addBlankMode = false;
  private uiBuilt = false;
  private savedBlanks: any[] | null = null;
  private savedFont: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BlanqPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BLANQ;
  }

  getDisplayText(): string {
    return this.file ? `Blanq: ${this.file.name}` : "Blanq Worksheet";
  }

  getIcon(): string {
    return "file-text";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "pdf";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("blanq-container");
    this.buildUI(container);
    this.uiBuilt = true;
  }

  async onClose(): Promise<void> {
    disposeModel();
  }

  // Called by Obsidian when a PDF file is opened into this view
  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    if (!this.uiBuilt) {
      // UI not ready yet — onOpen hasn't fired. It will call analyze via loadPdf flow.
      // We just need to wait for UI to be built, then load.
      const waitForUI = () => {
        if (this.uiBuilt) {
          this.loadPdfFromFile(file);
        } else {
          setTimeout(waitForUI, 50);
        }
      };
      waitForUI();
      return;
    }
    await this.loadPdfFromFile(file);
  }

  private async loadPdfFromFile(file: TFile): Promise<void> {
    const data = await this.app.vault.readBinary(file);
    let pdfBytes = new Uint8Array(data);

    // Check for embedded Blanq project data (saved by a previous export)
    const embedded = await this.extractWsaiData(pdfBytes);
    if (embedded) {
      // Use the original un-annotated PDF and restore blanks
      if (embedded.originalPdf) {
        pdfBytes = new Uint8Array(embedded.originalPdf);
      }
      this.pdfBytes = pdfBytes;
      this.leaf.updateHeader();
      this.savedBlanks = embedded.data.blanks;
      this.savedFont = embedded.data.font;
    } else {
      this.pdfBytes = pdfBytes;
      this.leaf.updateHeader();
      this.savedBlanks = null;
      this.savedFont = null;
    }

    await this.analyze();
  }

  private async extractWsaiData(pdfBytes: Uint8Array): Promise<{
    data: any; originalPdf: Uint8Array | null;
  } | null> {
    try {
      const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, decodePDFRawStream } = await import("pdf-lib");
      const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const catalog = doc.catalog;
      if (!catalog.has(PDFName.of("Names"))) return null;
      const Names = catalog.lookup(PDFName.of("Names"), PDFDict);
      if (!Names.has(PDFName.of("EmbeddedFiles"))) return null;
      let EF = Names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
      if (!EF.has(PDFName.of("Names")) && EF.has(PDFName.of("Kids"))) {
        EF = EF.lookup(PDFName.of("Kids"), PDFArray).lookup(0, PDFDict);
      }
      if (!EF.has(PDFName.of("Names"))) return null;
      const efNames = EF.lookup(PDFName.of("Names"), PDFArray);
      const attachments: Record<string, Uint8Array> = {};
      for (let i = 0; i < efNames.size(); i += 2) {
        const nameObj = efNames.lookup(i) as any;
        const name = nameObj.decodeText ? nameObj.decodeText() : nameObj.toString();
        const spec = efNames.lookup(i + 1, PDFDict);
        const efDict = spec.lookup(PDFName.of("EF"), PDFDict);
        const stream = efDict.lookup(PDFName.of("F"), PDFStream);
        attachments[name] = decodePDFRawStream(stream as any).decode();
      }
      if (!attachments["wsai-data.json"]) return null;
      const dataStr = new TextDecoder().decode(attachments["wsai-data.json"]);
      return {
        data: JSON.parse(dataStr),
        originalPdf: attachments["wsai-original.pdf"] || null,
      };
    } catch { return null; }
  }

  private buildUI(container: HTMLElement): void {
    // Inject styles
    const style = container.createEl("style");
    style.textContent = BLANQ_CSS;

    // Toolbar
    const toolbar = container.createDiv({ cls: "blanq-toolbar" });

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

    // Rotate button
    const rotateBtn = toolbar.createEl("button", {
      text: "Rotate",
      cls: "blanq-btn blanq-btn-ghost",
    });
    rotateBtn.addEventListener("click", () => this.rotatePdf());

    // AI Fill button (only works with API key in settings)
    const aiBtn = toolbar.createEl("button", {
      text: "AI Fill",
      cls: "blanq-btn blanq-btn-ai",
    });
    aiBtn.disabled = true;
    aiBtn.addEventListener("click", () => this.aiFill(aiBtn));
    if (this.plugin.settings.hideAi) {
      aiBtn.style.display = "none";
    }

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
    dropZone.createDiv({ text: "Open a PDF from the file explorer" });

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
        // Sort by visual reading order: page position first, then y, then x
        inputs.sort((a, b) => {
          const ap = a.closest(".blanq-pdf-page") as HTMLElement;
          const bp = b.closest(".blanq-pdf-page") as HTMLElement;
          const apOff = ap ? ap.offsetTop : 0;
          const bpOff = bp ? bp.offsetTop : 0;
          if (apOff !== bpOff) return apOff - bpOff;
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
    // Set the file on the FileView so getDisplayText works
    this.file = file;
    this.leaf.updateHeader();
    const data = await this.app.vault.readBinary(file);
    this.pdfBytes = new Uint8Array(data);
    await this.analyze();
  }

  private async analyze(): Promise<void> {
    if (!this.pdfBytes) return;
    const { viewer, exportBtn, aiBtn, dropZone } = this._refs;

    viewer.empty();
    this._refs.log.empty();
    this.blanks = [];
    this.pageTexts = {};
    exportBtn.style.display = "none";

    // Phase 1: Render all PDF pages first so the document is always visible
    interface PageInfo {
      wrap: HTMLElement;
      canvas: HTMLCanvasElement;
      vp1Width: number;
      vp1Height: number;
      displayScale: number;
      dpr: number;
      pageNum: number;
    }
    const pages: PageInfo[] = [];

    try {
      this.log("Loading PDF...");
      console.log("[Blanq] Starting PDF analysis...");

      const pdfjsLib = await import("pdfjs-dist");
      const fs = require("fs");
      const workerPath = require("path").join(
        this.plugin.getPluginDir(), "pdf.worker.min.js"
      );
      console.log(`[Blanq] Reading worker from: ${workerPath}`);
      const workerCode = fs.readFileSync(workerPath, "utf8");
      const blob = new Blob([workerCode], { type: "application/javascript" });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);

      this.log("Parsing PDF...");
      const pdf = await pdfjsLib.getDocument({ data: this.pdfBytes.slice() }).promise;
      const numPages = pdf.numPages;
      this.log(`${numPages} page(s) loaded`, "ok");

      const containerW = viewer.clientWidth || 800;

      for (let p = 1; p <= numPages; p++) {
        const page = await pdf.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });

        // Extract text
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

        // Click to add blank
        const pg = p;
        wrap.addEventListener("click", (e) =>
          this.handleAddBlankClick(e, wrap, canvas, pg)
        );

        pages.push({
          wrap, canvas, vp1Width: vp1.width, vp1Height: vp1.height,
          displayScale, dpr, pageNum: p,
        });
      }
    } catch (err: any) {
      console.error("[Blanq] PDF rendering failed:", err);
      this.log(`Error loading PDF: ${err.message}`, "err");
      return;
    }

    // Phase 2: Restore saved blanks or run detection
    const fontFamily = this.savedFont === "jetbrains" ? "JetBrains Mono"
      : this.savedFont === "kalam" ? "Kalam"
      : (this._refs.fontSel.value === "jetbrains" ? "JetBrains Mono" : "Kalam");
    if (this.savedFont) {
      this._refs.fontSel.value = this.savedFont;
    }
    let allBlanks: BlankBox[] = [];

    if (this.savedBlanks) {
      // Restore blanks from embedded project data
      this.log("Restoring saved blanks...");
      for (const sb of this.savedBlanks) {
        const pg = pages.find(p => p.pageNum === sb.page);
        if (!pg) continue;
        const b: BlankBox = {
          x: sb.x, y: sb.y, width: sb.width, height: sb.height,
          confidence: sb.confidence, page: sb.page,
          canvasW: sb.canvasW, canvasH: sb.canvasH,
          answer: sb.answer || "", type: sb.type,
          mergedHeights: sb.mergedHeights || [sb.height],
          lineHeightPx: sb.lineHeightPx, lineCount: sb.lineCount,
          vw: pg.vp1Width, vh: pg.vp1Height,
          displayScale: pg.displayScale, dpr: pg.dpr,
        };
        const ox = b.x / pg.dpr, oy = b.y / pg.dpr,
          ow = b.width / pg.dpr, oh = b.height / pg.dpr;
        const ta = this.createOverlayInput(pg.wrap, b, ox, oy, ow, oh, fontFamily, pg.dpr);
        ta.placeholder = "#" + (allBlanks.length + 1);
        if (b.answer) {
          ta.value = b.answer;
          ta.classList.add("filled");
        }
        allBlanks.push(b);
      }
      this.log(`Restored ${allBlanks.length} blank(s) with answers`, "ok");
      this.savedBlanks = null;
      this.savedFont = null;
    } else {
      // Run model detection
      const modelPath = this.plugin.getModelPath();
      const pluginDir = this.plugin.getPluginDir();
      this.log("Detecting blanks...");

      for (const pg of pages) {
        try {
          const pageBlanks = await detectBlanks(pg.canvas, pg.pageNum, modelPath, pluginDir);
          this.log(`${pageBlanks.length} blank(s) on page ${pg.pageNum}`, "ok");

          pageBlanks.sort((a, b) => a.y - b.y || a.x - b.x);

          for (const b of pageBlanks) {
            const ox = b.x / pg.dpr,
              oy = b.y / pg.dpr,
              ow = b.width / pg.dpr,
              oh = b.height / pg.dpr;
            const ta = this.createOverlayInput(pg.wrap, b, ox, oy, ow, oh, fontFamily, pg.dpr);
            ta.placeholder = "#" + (allBlanks.length + pageBlanks.indexOf(b) + 1);

            b.vw = pg.vp1Width;
            b.vh = pg.vp1Height;
            b.displayScale = pg.displayScale;
            b.dpr = pg.dpr;
          }

          allBlanks.push(...pageBlanks);
        } catch (err: any) {
          console.error(`[Blanq] Page ${pg.pageNum}: detection failed:`, err);
          this.log(`Detection failed on page ${pg.pageNum}: ${err.message}`, "err");
        }
      }
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
      this.log("No blanks detected. Use '+ Add Blank' to mark fields manually.", "warn");
      return;
    }

    this.log(`${allBlanks.length} answer region(s) found`, "ok");
    exportBtn.style.display = "";
    aiBtn.disabled = !this.plugin.settings.apiKey;
    this.log("Ready — click blanks to type, or use AI Fill.", "ok");
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

    ta.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // Block Enter if adding a newline would overflow
        const curLh = parseFloat(ta.style.lineHeight);
        const maxLines = Math.floor(oh / curLh + 0.1);
        const totalLines = ta.value.split("\n").length;
        if (totalLines >= maxLines) e.preventDefault();
      }
    });

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

    // Push text to bottom of box (extra space on top, text sits on the line)
    const contentH = ta.scrollHeight;
    const slack = boxH - contentH;
    ta.style.paddingTop = (slack > 1 ? slack : 0) + "px";
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

  // ── Rotate PDF ──
  private async rotatePdf(): Promise<void> {
    if (!this.pdfBytes) return;
    this.log("Rotating PDF...");
    try {
      const { PDFDocument, degrees } = await import("pdf-lib");
      const doc = await PDFDocument.load(this.pdfBytes, { ignoreEncryption: true });
      const pages = doc.getPages();
      for (const page of pages) {
        const cur = page.getRotation().angle;
        page.setRotation(degrees((cur + 90) % 360));
      }
      const saved = await doc.save();
      this.pdfBytes = new Uint8Array(saved);
      // Save rotated PDF to vault
      if (this.file) {
        await this.app.vault.modifyBinary(this.file, saved);
      }
      // Clear and re-analyze with rotated PDF
      this.blanks = [];
      this.pageTexts = {};
      await this.analyze();
      this.log("Rotated 90° and saved", "ok");
    } catch (err: any) {
      this.log(`Rotate failed: ${err.message}`, "err");
    }
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

      // Gather actual rendered font sizes from the DOM textareas
      const textareas = this._refs.viewer.querySelectorAll<HTMLTextAreaElement>(".blanq-overlay-input");

      for (let i = 0; i < this.blanks.length; i++) {
        const b = this.blanks[i];
        const ansText = b.answer?.trim();
        if (!ansText) continue;
        const pg = pages[b.page - 1];
        const rot = pg.getRotation().angle % 360;
        const rawW = pg.getWidth(), rawH = pg.getHeight();
        const isRotated90 = (rot === 90 || rot === 270);
        const effW = isRotated90 ? rawH : rawW;
        const effH = isRotated90 ? rawW : rawH;
        const dpr = b.dpr || window.devicePixelRatio || 1;

        // Convert canvas pixel coords to effective PDF points
        const sx = effW / b.canvasW, sy = effH / b.canvasH;
        const effX = b.x * sx;
        const effY = effH - (b.y + b.height) * sy;
        const effPdfW = b.width * sx;
        const effPdfH = b.height * sy;

        // Read actual rendered font size from the DOM textarea
        const ta = textareas[i];
        const cssFontSize = ta ? parseFloat(ta.style.fontSize) : 0;
        const cssLineHeight = ta ? parseFloat(ta.style.lineHeight) : 0;
        const cssToPdf = effW / (b.canvasW / dpr);

        let fs: number, lineH: number;
        if (cssFontSize > 0 && cssLineHeight > 0) {
          fs = cssFontSize * cssToPdf;
          lineH = cssLineHeight * cssToPdf;
        } else {
          const nLines = Math.max(1, Math.round(effPdfH / (effPdfH > 30 ? 14 : effPdfH)));
          lineH = effPdfH / nLines;
          fs = lineH * 0.7;
        }

        const ansLines = ansText.split("\n");
        let allWrapped: string[] = [];
        let tryFs = fs;
        const wrapW = effPdfW - 6 * cssToPdf;
        while (tryFs >= 3) {
          allWrapped = [];
          for (const line of ansLines)
            allWrapped.push(...wrapLine(line, handFont, tryFs, wrapW));
          const maxLines2 = Math.max(1, Math.floor(effPdfH / lineH + 0.1));
          if (allWrapped.length <= maxLines2) break;
          tryFs -= 0.5;
        }
        fs = tryFs;
        const maxLines = Math.max(1, Math.floor(effPdfH / lineH + 0.1));
        if (allWrapped.length > maxLines)
          allWrapped = allWrapped.slice(0, maxLines);
        const padX = 3 * cssToPdf;

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
          const eTextX = effX + padX;
          const eTextY = effY + effPdfH - lineH * (k + 1) + (lineH - fs) * 0.35;
          let drawX: number, drawY: number;
          if (rot === 90) { drawX = effH - eTextY; drawY = eTextX; }
          else if (rot === 180) { drawX = effW - eTextX; drawY = effH - eTextY; }
          else if (rot === 270) { drawX = eTextY; drawY = effW - eTextX; }
          else { drawX = eTextX; drawY = eTextY; }
          pg.drawText(safeText, {
            x: drawX, y: drawY, size: fs, font: handFont, color: ansTextC,
            rotate: (await import("pdf-lib")).degrees(rot),
          });
        }
      }

      // Embed project data so blanks + answers can be restored on re-open
      const wsaiData = {
        version: 1,
        font: fontChoice,
        blanks: this.blanks.map(b => ({
          x: b.x, y: b.y, width: b.width, height: b.height,
          page: b.page, canvasW: b.canvasW, canvasH: b.canvasH,
          confidence: b.confidence, type: b.type, answer: b.answer || "",
          mergedHeights: b.mergedHeights || null,
          lineHeightPx: b.lineHeightPx || null,
          lineCount: b.lineCount || null,
          vw: b.vw, vh: b.vh, displayScale: b.displayScale, dpr: b.dpr,
        })),
      };
      await doc.attach(
        new TextEncoder().encode(JSON.stringify(wsaiData)),
        "wsai-data.json",
        { mimeType: "application/json", description: "Blanq project data" }
      );
      await doc.attach(this.pdfBytes!, "wsai-original.pdf", {
        mimeType: "application/pdf", description: "Original unmodified PDF",
      });

      const out = await doc.save();

      // Overwrite the original PDF
      if (this.file) {
        await this.app.vault.modifyBinary(this.file, out);
        // Update our local copy so further edits build on the saved version
        this.pdfBytes = new Uint8Array(out);
        this.log(`Saved to ${this.file.path}`, "ok");
        new Notice(`Blanq: Saved ${this.file.name}`);
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
  background: rgba(255,255,255,0.0);
  border: none;
  outline: none;
  color: #1a1a2a;
  caret-color: #1a1a2a;
  padding: 0 3px;
  margin: 0;
  resize: none;
  overflow: hidden;
  line-height: 1;
  transition: background 0.15s ease;
  word-break: break-word;
  box-sizing: border-box;
}
.blanq-overlay-input:hover {
  background: transparent;
}
.blanq-overlay-input:focus {
  background: rgba(255,255,255,0.92);
  caret-color: #1a1a2a;
  box-shadow: 0 0 0 2px rgba(99,102,241,0.6);
}
.blanq-overlay-input.filled {
  background: transparent;
}
.blanq-overlay-input.filled:focus {
  background: rgba(255,255,255,0.92);
}
.blanq-overlay-input::placeholder {
  color: transparent;
}
`;
