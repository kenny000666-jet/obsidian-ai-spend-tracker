import {
  App, Plugin, PluginSettingTab, Setting,
  Notice, ItemView, WorkspaceLeaf,
} from "obsidian";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const VIEW_TYPE = "ai-spend-tracker";
const BAR_WIDTH = 20;

interface SpendData {
  used: number; limit: number; pct: number;
  remaining: number; daily: number; resets: string;
}
interface CopilotData {
  used: number; limit: number; remaining: number; resets: string;
}
interface SpendCache {
  fetchedAt: number; claude: SpendData | null; copilot: CopilotData | null;
}
interface AiSpendSettings {
  keychainAccount: string; claudeBudget: number; copilotBudget: number;
  cacheTtlHours: number; binPath: string; showInRibbon: boolean;
}

const DEFAULT_SETTINGS: AiSpendSettings = {
  keychainAccount: "", claudeBudget: 200, copilotBudget: 200,
  cacheTtlHours: 4, binPath: "/opt/homebrew/bin:/usr/bin:/bin", showInRibbon: true,
};

function fmt(n: number) { return `$${n.toFixed(2)}`; }
function daysLeft() {
  const now = new Date();
  return Math.max(new Date(now.getFullYear(), now.getMonth()+1, 0).getDate() - now.getDate(), 1);
}
function nextMonth() {
  return new Date(new Date().getFullYear(), new Date().getMonth()+1, 1)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default class AiSpendPlugin extends Plugin {
  settings!: AiSpendSettings;
  private cacheFile!: string;

  async onload() {
    await this.loadSettings();
    this.cacheFile = path.join(
      (this.app.vault.adapter as any).basePath,
      ".obsidian", "plugins", this.manifest.id, "spend-cache.json"
    );
    this.registerView(VIEW_TYPE, (leaf) => new SpendView(leaf, this));
    if (this.settings.showInRibbon) {
      this.addRibbonIcon("dollar-sign", "AI Spend Tracker", () => this.activateView());
    }
    this.addCommand({ id: "open-spend-tracker", name: "Open AI Spend Tracker", callback: () => this.activateView() });
    this.addCommand({ id: "refresh-spend", name: "Refresh spend data (force)", callback: () => {
      this.clearCache(); this.activateView(); new Notice("AI Spend Tracker: refreshing...");
    }});
    this.addSettingTab(new AiSpendSettingTab(this.app, this));
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  loadCache(): SpendCache {
    try { return JSON.parse(fs.readFileSync(this.cacheFile, "utf8")); }
    catch { return { fetchedAt: 0, claude: null, copilot: null }; }
  }
  saveCache(c: SpendCache) {
    try { fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true }); fs.writeFileSync(this.cacheFile, JSON.stringify(c, null, 2)); }
    catch (e) { console.warn("[AI Spend] cache write failed:", e); }
  }
  clearCache() { try { fs.unlinkSync(this.cacheFile); } catch {} }

  sh(cmd: string): string {
    return execSync(cmd, { encoding: "utf8", shell: "/bin/zsh",
      env: { ...process.env, PATH: this.settings.binPath }, timeout: 20000 }).trim();
  }

  getClaudeToken(): string | null {
    const platform = process.platform;

    // ── macOS: read from Keychain ────────────────────────────────────────
    if (platform === "darwin") {
      try {
        const account = this.settings.keychainAccount || this.sh("id -un");
        const raw = this.sh(
          `security find-generic-password -s "Claude Code-credentials" -a "${account}" -w 2>/dev/null`
        );
        const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (token) return token;
      } catch (e) {
        console.warn("[AI Spend] macOS Keychain read failed:", e);
      }
    }

    // ── Linux / Windows: read from ~/.claude/.credentials.json ──────────
    const credPaths = [
      path.join(process.env.CLAUDE_CONFIG_DIR || "", ".credentials.json"),
      path.join(process.env.HOME || process.env.USERPROFILE || "", ".claude", ".credentials.json"),
    ].filter(p => p.length > 20); // filter out empty-prefix paths

    for (const credPath of credPaths) {
      try {
        if (!fs.existsSync(credPath)) continue;
        const raw = fs.readFileSync(credPath, "utf8");
        const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (token) {
          console.log(`[AI Spend] read token from ${credPath}`);
          return token;
        }
      } catch (e) {
        console.warn(`[AI Spend] failed to read ${credPath}:`, e);
      }
    }

    return null;
  }

  fetchClaude(): SpendData | null {
    try {
      const token = this.getClaudeToken();
      if (!token) { console.warn("[AI Spend] no Claude token found"); return null; }
      const resp = this.sh(`curl -sf -m 10 "https://api.anthropic.com/api/oauth/usage" -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20"`);
      const eu = JSON.parse(resp)?.extra_usage;
      if (!eu) return null;
      const div = Math.pow(10, eu.decimal_places ?? 2);
      const used = eu.used_credits / div;
      const limit = this.settings.claudeBudget || eu.monthly_limit / div;
      const remaining = Math.max(limit - used, 0);
      return { used, limit, pct: (used/limit)*100, remaining, daily: remaining/daysLeft(), resets: nextMonth() };
    } catch (e) { console.warn("[AI Spend] Claude fetch failed:", e); return null; }
  }

  fetchCopilot(): CopilotData | null {
    try {
      const d = JSON.parse(this.sh("uvx copilot-spend --json 2>/dev/null"));
      const limit = parseFloat(d.dollars_entitlement ?? this.settings.copilotBudget);
      const rem = parseFloat(d.dollars_free_remaining ?? 0);
      const owed = parseFloat(d.dollars_owed ?? 0);
      const used = Math.max(limit - rem, 0) + owed;
      const resets = d.reset ? new Date(d.reset).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
      return { used, limit, remaining: rem, resets };
    } catch (e) { console.warn("[AI Spend] Copilot fetch failed:", e); return null; }
  }

  async getSpend(force = false): Promise<SpendCache> {
    const cache = this.loadCache();
    const age = Date.now() - (cache.fetchedAt ?? 0);
    const ttl = this.settings.cacheTtlHours * 3600 * 1000;
    if (!force && age <= ttl) return cache;
    const claude = this.fetchClaude();
    const copilot = this.fetchCopilot();
    const updated: SpendCache = { fetchedAt: Date.now(), claude: claude ?? cache.claude, copilot: copilot ?? cache.copilot };
    this.saveCache(updated);
    return updated;
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

class SpendView extends ItemView {
  plugin: AiSpendPlugin;
  constructor(leaf: WorkspaceLeaf, plugin: AiSpendPlugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI Spend Tracker"; }
  getIcon() { return "dollar-sign"; }
  async onOpen() { await this.render(); }

  async render(force = false) {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ai-spend-tracker");
    const loading = container.createDiv({ cls: "ai-spend-loading" });
    loading.setText("⏳ Fetching spend data...");
    let cache: SpendCache;
    try { cache = await this.plugin.getSpend(force); } catch (e) { loading.setText(`❌ ${e}`); return; }
    loading.remove();

    const age = Date.now() - (cache.fetchedAt ?? 0);
    const stamp = new Date(cache.fetchedAt ?? Date.now())
      .toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" });

    const header = container.createDiv({ cls: "ai-spend-header" });
    header.createEl("h4", { text: "💰 AI Spend Tracker" });
    header.createEl("p", { cls: "ai-spend-meta",
      text: age < 120000 ? `Updated ${stamp}` : `Cached ${Math.round(age/60000)}m ago (${stamp})` });
    const btn = header.createEl("button", { cls: "ai-spend-refresh", text: "↻ Refresh" });
    btn.addEventListener("click", () => this.render(true));
    container.createEl("hr");

    this.renderCard(container, {
      icon: "🤖", title: "GitHub Copilot",
      subtitle: cache.copilot ? `Resets ${cache.copilot.resets}` : "Not configured",
      data: cache.copilot ? { used: cache.copilot.used, limit: cache.copilot.limit,
        pct: (cache.copilot.used/cache.copilot.limit)*100, remaining: cache.copilot.remaining,
        extra: `${fmt(cache.copilot.remaining)} left` } : null,
    });
    this.renderCard(container, {
      icon: "🧠", title: "Claude.ai",
      subtitle: cache.claude ? `Resets ${cache.claude.resets}` : "Not configured",
      data: cache.claude ? { used: cache.claude.used, limit: cache.claude.limit,
        pct: cache.claude.pct, remaining: cache.claude.remaining,
        extra: `${fmt(cache.claude.remaining)} left · ~${fmt(cache.claude.daily)}/day` } : null,
    });

    if (cache.copilot && cache.claude) {
      container.createEl("hr");
      const total = container.createDiv({ cls: "ai-spend-total" });
      total.createEl("p").innerHTML =
        `<strong>Total this month:</strong> <span class="ai-spend-amount">${fmt(cache.copilot.used + cache.claude.used)}</span>`;
    }
  }

  renderCard(container: HTMLElement, opts: {
    icon: string; title: string; subtitle: string;
    data: { used: number; limit: number; pct: number; remaining: number; extra: string } | null;
  }) {
    const card = container.createDiv({ cls: "ai-spend-card" });
    const h = card.createDiv({ cls: "ai-spend-card-header" });
    h.createSpan({ text: `${opts.icon} ${opts.title}`, cls: "ai-spend-card-title" });
    h.createSpan({ text: opts.subtitle, cls: "ai-spend-card-subtitle" });
    if (!opts.data) { card.createEl("p", { cls: "ai-spend-unavailable", text: "⚠️ Unavailable — check settings" }); return; }
    const { used, limit, pct, extra } = opts.data;
    const cls = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "ok";
    const wrap = card.createDiv({ cls: "ai-spend-bar-wrap" });
    const bar = wrap.createDiv({ cls: `ai-spend-bar ai-spend-bar-${cls}` });
    bar.style.width = `${Math.min(pct, 100)}%`;
    const nums = card.createDiv({ cls: "ai-spend-nums" });
    nums.createSpan({ cls: "ai-spend-used", text: `${fmt(used)} / ${fmt(limit)}` });
    nums.createSpan({ cls: "ai-spend-pct", text: `${Math.round(pct)}%` });
    card.createEl("p", { cls: "ai-spend-extra", text: extra });
  }
}

class AiSpendSettingTab extends PluginSettingTab {
  plugin: AiSpendPlugin;
  constructor(app: App, plugin: AiSpendPlugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Spend Tracker" });

    new Setting(containerEl).setName("macOS Keychain account (macOS only)")
      .setDesc('Your macOS username (run "id -un" in Terminal). Only needed on macOS — Linux and Windows read credentials from ~/.claude/.credentials.json automatically. Leave blank to auto-detect.')
      .addText(t => t.setPlaceholder("e.g. jsmith").setValue(this.plugin.settings.keychainAccount)
        .onChange(async v => { this.plugin.settings.keychainAccount = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Claude.ai monthly budget (USD)")
      .setDesc("Your programmatic credit pool. Check claude.ai → Settings → Usage limits.")
      .addText(t => t.setPlaceholder("200").setValue(String(this.plugin.settings.claudeBudget))
        .onChange(async v => { this.plugin.settings.claudeBudget = parseFloat(v)||200; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("GitHub Copilot budget (USD)")
      .setDesc("Fallback if the Copilot API doesn't return an entitlement value.")
      .addText(t => t.setPlaceholder("200").setValue(String(this.plugin.settings.copilotBudget))
        .onChange(async v => { this.plugin.settings.copilotBudget = parseFloat(v)||200; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Cache TTL (hours)")
      .setDesc("How long to cache spend data. Minimum 1h recommended to avoid rate limits.")
      .addSlider(s => s.setLimits(1,24,1).setValue(this.plugin.settings.cacheTtlHours).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.cacheTtlHours = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Binary PATH")
      .setDesc("PATH for shell commands. Defaults work for Homebrew on Apple Silicon.")
      .addText(t => t.setValue(this.plugin.settings.binPath)
        .onChange(async v => { this.plugin.settings.binPath = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Show ribbon icon").setDesc("Requires Obsidian restart.")
      .addToggle(t => t.setValue(this.plugin.settings.showInRibbon)
        .onChange(async v => { this.plugin.settings.showInRibbon = v; await this.plugin.saveSettings(); }));
    containerEl.createEl("h3", { text: "Actions" });
    new Setting(containerEl).setName("Clear cache").setDesc("Force a fresh fetch on next open.")
      .addButton(b => b.setButtonText("Clear cache").onClick(() => {
        this.plugin.clearCache(); new Notice("AI Spend: cache cleared");
      }));
  }
}
