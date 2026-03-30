import { Plugin, TFile, WorkspaceLeaf, PluginSettingTab, App, Setting } from "obsidian";
import { BlanqView, VIEW_TYPE_BLANQ } from "./blanq-view";
import path from "path";

interface BlanqSettings {
  apiKey: string;
  apiProvider: "anthropic" | "openai";
}

const DEFAULT_SETTINGS: BlanqSettings = {
  apiKey: "",
  apiProvider: "anthropic",
};

export default class BlanqPlugin extends Plugin {
  settings: BlanqSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register the custom view
    this.registerView(VIEW_TYPE_BLANQ, (leaf) => new BlanqView(leaf, this));

    // Add ribbon icon
    this.addRibbonIcon("file-text", "Open Blanq Worksheet", () => {
      this.activateView();
    });

    // Add command to open view
    this.addCommand({
      id: "open-blanq",
      name: "Open Blanq Worksheet",
      callback: () => this.activateView(),
    });

    // Add command to open current PDF in Blanq
    this.addCommand({
      id: "open-pdf-in-blanq",
      name: "Open current PDF in Blanq",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "pdf") {
          if (!checking) this.openPdfInBlanq(file);
          return true;
        }
        return false;
      },
    });

    // Register PDF file menu item
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "pdf") {
          menu.addItem((item) => {
            item
              .setTitle("Open in Blanq")
              .setIcon("file-text")
              .onClick(() => this.openPdfInBlanq(file));
          });
        }
      })
    );

    // Open PDFs in Blanq when clicked in file explorer
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "pdf") {
          // Check if there's already a Blanq view for this — avoid infinite loops
          const blanqLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BLANQ);
          const alreadyOpen = blanqLeaves.some(
            (l) => (l.view as BlanqView).getDisplayText() === `Blanq: ${file.name}`
          );
          if (!alreadyOpen) {
            this.openPdfInBlanq(file);
          }
        }
      })
    );

    // Settings tab
    this.addSettingTab(new BlanqSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BLANQ);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getModelPath(): string {
    // The model file is in the plugin directory
    const pluginDir = (this.app.vault.adapter as any).getBasePath
      ? path.join(
          (this.app.vault.adapter as any).getBasePath(),
          this.app.vault.configDir,
          "plugins",
          this.manifest.id,
          "FFDNet-S.onnx"
        )
      : "";

    // For ONNX Runtime Web, use a file:// URL or vault adapter path
    // In Electron, we can use the absolute path
    return pluginDir;
  }

  private async activateView(): Promise<void> {
    const existing =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_BLANQ);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_BLANQ, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async openPdfInBlanq(file: TFile): Promise<void> {
    let leaf: WorkspaceLeaf;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_BLANQ);
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_BLANQ, active: true });
    }
    this.app.workspace.revealLeaf(leaf);

    const view = leaf.view as BlanqView;
    await view.loadPdf(file);
  }
}

class BlanqSettingTab extends PluginSettingTab {
  plugin: BlanqPlugin;

  constructor(app: App, plugin: BlanqPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Blanq Worksheet Settings" });

    containerEl.createEl("p", {
      text: "The blank detection works fully offline. AI Fill is optional and requires an API key.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("Choose which AI provider to use for AI Fill (optional)")
      .addDropdown((drop) =>
        drop
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("openai", "OpenAI (GPT-4o)")
          .setValue(this.plugin.settings.apiProvider)
          .onChange(async (value) => {
            this.plugin.settings.apiProvider = value as "anthropic" | "openai";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("API key for AI Fill. Leave empty for offline-only mode.")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
