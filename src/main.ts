import { App, Plugin, PluginSettingTab, Setting, Notice, WorkspaceLeaf } from "obsidian";
import { TaskServiceClient } from "./service-client";
import { TasksServer } from "./server";
import { TasksBoardView, VIEW_TYPE_TASKS } from "./board-view";
import { QUEUE_PROMPT } from "./prompt";
import { ensureConfig, writeDefaultConfig, QueueConfig } from "./config";

interface AgentTasksSettings {
  nodePath: string;
  serviceScript: string;
  dbPath: string;
  configPath: string;
  enableServer: boolean;
  serverPort: number;
  serverApiKey: string;
}

const DEFAULT_SETTINGS: AgentTasksSettings = {
  nodePath: "node",
  serviceScript: "",
  dbPath: "",
  configPath: "",
  enableServer: true,
  serverPort: 8766, // il plugin RAG usa 8765
  serverApiKey: "",
};

export default class AgentTasksPlugin extends Plugin {
  settings!: AgentTasksSettings;
  svc!: TaskServiceClient;
  server!: TasksServer;
  config!: QueueConfig;
  configPath = "";

  async onload() {
    await this.loadSettings();
    if (!this.settings.serverApiKey) {
      this.settings.serverApiKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await this.saveSettings();
    }

    const dir = this.pluginDirAbs();
    const serviceScript = this.settings.serviceScript || `${dir}/task-service.cjs`;
    const dbPath = this.settings.dbPath || `${dir}/tasks.db`;
    // garantisce che queue.config.json esista (scrive il default se manca) e lo carica per la UI
    this.configPath = this.settings.configPath || `${dir}/queue.config.json`;
    this.config = ensureConfig(this.configPath);

    this.svc = new TaskServiceClient(this.settings.nodePath, serviceScript, dbPath, this.configPath, (lvl, msg) => {
      if (lvl === "error") console.error("[agent-queue]", msg);
      else console.log("[agent-queue]", msg);
    });

    this.server = new TasksServer(this);

    this.registerView(VIEW_TYPE_TASKS, (leaf: WorkspaceLeaf) => new TasksBoardView(leaf, this));
    this.addRibbonIcon("list-checks", this.config.labels.ribbon, () => void this.activateView());

    this.addCommand({ id: "agent-tasks-open", name: "Apri board", callback: () => void this.activateView() });
    this.addCommand({
      id: "agent-tasks-health",
      name: "Stato servizio (health)",
      callback: async () => {
        try {
          const h = await this.svc.health();
          new Notice(`Task Queue: ${h.tasks} task, ${h.plans} piani`);
        } catch (e) {
          new Notice(`Errore: ${String((e as Error).message)}`);
        }
      },
    });
    this.addCommand({
      id: "agent-tasks-copy-prompt",
      name: "Copia prompt per agente",
      callback: async () => {
        await navigator.clipboard.writeText(QUEUE_PROMPT);
        new Notice("Prompt copiato negli appunti");
      },
    });

    this.addSettingTab(new AgentTasksSettingTab(this.app, this));

    if (this.settings.enableServer) {
      this.server.start(this.settings.serverPort, this.settings.serverApiKey);
    }
  }

  onunload() {
    this.server?.stop();
    this.svc?.dispose();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  pluginDirAbs(): string {
    const base = (this.app.vault.adapter as any).basePath as string;
    return `${base}/${this.manifest.dir}`;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  restartServer() {
    this.server.stop();
    if (this.settings.enableServer) this.server.start(this.settings.serverPort, this.settings.serverApiKey);
  }

  // piano demo arricchito: DAG con fan-out/fan-in, tag-routing, priorità, approvazione, budget
  async createDemoPlan() {
    await this.svc.createPlan({
      spec: "piano demo — mostra DAG (fan-out/fan-in), tag-routing, priorità, approvazione e budget",
      budget: { maxDispatches: 20 },
      tasks: [
        { taskKey: "CTX", title: "Raccolta contesto", workerType: "CONTEXT", priority: 2, tags: ["analysis"] },
        { taskKey: "SCHEMA", title: "Design schema dati", workerType: "ARCH", priority: 3, dependsOn: ["CTX"], tags: ["analysis"] },
        { taskKey: "BE", title: "Implementa backend", workerType: "BE", priority: 5, dependsOn: ["SCHEMA"], tags: ["backend"] },
        { taskKey: "FE", title: "Implementa frontend", workerType: "FE", priority: 5, dependsOn: ["SCHEMA"], tags: ["frontend"] },
        { taskKey: "TEST", title: "Test integrazione", workerType: "QA", priority: 4, dependsOn: ["BE", "FE"], tags: ["qa"] },
        { taskKey: "DOCS", title: "Documentazione", workerType: "DOC", priority: 8, dependsOn: ["BE", "FE"] },
        { taskKey: "REVIEW", title: "Review finale", workerType: "REVIEW", priority: 3, dependsOn: ["TEST", "DOCS"], requireApproval: true, tags: ["review"] },
        { taskKey: "DEPLOY", title: "Deploy in produzione", workerType: "OPS", priority: 1, dependsOn: ["REVIEW"], tags: ["ops"] },
      ],
    });
  }
}

class AgentTasksSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AgentTasksPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Task Queue — coda e stati dei task" });

    new Setting(containerEl)
      .setName("Percorso di Node")
      .setDesc("Eseguibile node di sistema. Usa node:sqlite nativo se ≥22.5, altrimenti sql.js WASM. Lascia 'node' se è nel PATH.")
      .addText((t) =>
        t.setValue(this.plugin.settings.nodePath).onChange(async (v) => {
          this.plugin.settings.nodePath = v.trim() || "node";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Script servizio (opzionale)")
      .setDesc("Override del path a task-service.cjs. Vuoto = dentro la cartella del plugin.")
      .addText((t) =>
        t.setValue(this.plugin.settings.serviceScript).onChange(async (v) => {
          this.plugin.settings.serviceScript = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("File database (opzionale)")
      .setDesc("Override del path al .db. Vuoto = tasks.db dentro la cartella del plugin.")
      .addText((t) =>
        t.setValue(this.plugin.settings.dbPath).onChange(async (v) => {
          this.plugin.settings.dbPath = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Configurazione (queue.config.json)").setHeading();

    new Setting(containerEl)
      .setName("File di configurazione")
      .setDesc(
        `Tutto è configurabile da questo JSON: stati, transizioni, ordinamento, tipi worker, etichette colonne, nomi, default. Attivo: ${this.plugin.configPath}`,
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.configPath).onChange(async (v) => {
          this.plugin.settings.configPath = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Rigenera config di default")
      .setDesc("Sovrascrive il file con la configurazione di default. Le modifiche richiedono il reload del plugin.")
      .addButton((b) =>
        b.setButtonText("Rigenera").setWarning().onClick(() => {
          writeDefaultConfig(this.plugin.configPath);
          new Notice("queue.config.json rigenerato (ricarica il plugin per applicare)");
        }),
      );

    new Setting(containerEl).setName("Strumenti").setHeading();

    new Setting(containerEl)
      .setName("Crea piano demo")
      .setDesc("Inserisce un piano d'esempio (DAG con fan-out/fan-in, tag, priorità, approvazione, budget) per provare la coda.")
      .addButton((b) =>
        b.setButtonText("Crea piano demo").onClick(async () => {
          try {
            await this.plugin.createDemoPlan();
            new Notice("piano demo creato");
          } catch (e) {
            new Notice(`Errore: ${String((e as Error).message)}`);
          }
        }),
      );

    new Setting(containerEl).setName("Server REST").setHeading();

    new Setting(containerEl)
      .setName("Abilita server REST")
      .setDesc("Espone la coda su 127.0.0.1 per CLI/agenti.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableServer).onChange(async (v) => {
          this.plugin.settings.enableServer = v;
          await this.plugin.saveSettings();
          this.plugin.restartServer();
        }),
      );

    new Setting(containerEl).setName("Porta").addText((t) =>
      t.setValue(String(this.plugin.settings.serverPort)).onChange(async (v) => {
        this.plugin.settings.serverPort = Number(v) || 8766;
        await this.plugin.saveSettings();
        this.plugin.restartServer();
      }),
    );

    new Setting(containerEl)
      .setName("API key (Bearer)")
      .setDesc("Richiesta per le mutazioni; non per /health,/prompt,/tools.")
      .addText((t) =>
        t.setValue(this.plugin.settings.serverApiKey).onChange(async (v) => {
          this.plugin.settings.serverApiKey = v.trim();
          await this.plugin.saveSettings();
          this.plugin.restartServer();
        }),
      );
  }
}
