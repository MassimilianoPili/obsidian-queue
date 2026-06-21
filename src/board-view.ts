import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice } from "obsidian";
import type AgentTasksPlugin from "./main";

export const VIEW_TYPE_TASKS = "agent-tasks-board";

const COLUMNS: { status: string; label: string }[] = [
  { status: "AWAITING_APPROVAL", label: "In approvazione" },
  { status: "WAITING", label: "In coda" },
  { status: "DISPATCHED", label: "In corso" },
  { status: "DONE", label: "Completati" },
  { status: "FAILED", label: "Falliti" },
];

export class TasksBoardView extends ItemView {
  private refreshTimer: number | null = null;
  private currentPlanId = "";

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: AgentTasksPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_TASKS;
  }
  getDisplayText() {
    return "Agent Tasks";
  }
  getIcon() {
    return "list-checks";
  }

  async onOpen() {
    this.refreshTimer = window.setInterval(() => void this.render(), 2000);
    await this.render();
  }

  async onClose() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }

  private async render() {
    const root = this.containerEl.children[1] as HTMLElement;
    if (!root) return;
    let tasks: any[] = [];
    try {
      tasks = (await this.plugin.svc.listTasks({})) || [];
    } catch (e) {
      root.empty();
      root.createEl("p", { text: `Servizio non pronto: ${String((e as Error).message)}` });
      return;
    }
    // preserva lo scroll
    const prevScroll = root.scrollTop;
    root.empty();
    root.addClass("agent-tasks-root");

    const toolbar = root.createDiv({ cls: "at-toolbar" });
    toolbar.createEl("button", { text: "Aggiorna" }).onclick = () => void this.render();
    toolbar.createEl("button", { text: "Piano demo" }).onclick = async () => {
      await this.createDemoPlan();
      await this.render();
    };
    const planIds = [...new Set(tasks.map((t) => t.plan_id))];
    if (planIds.length) {
      const sel = toolbar.createEl("select");
      sel.createEl("option", { text: "Tutti i piani", value: "" });
      for (const pid of planIds) sel.createEl("option", { text: pid.slice(0, 8), value: pid });
      sel.value = this.currentPlanId;
      sel.onchange = () => {
        this.currentPlanId = sel.value;
        void this.render();
      };
    }

    const shown = this.currentPlanId ? tasks.filter((t) => t.plan_id === this.currentPlanId) : tasks;

    const board = root.createDiv({ cls: "at-board" });
    for (const col of COLUMNS) {
      const colEl = board.createDiv({ cls: "at-col" });
      const items = shown.filter((t) => t.status === col.status);
      colEl.createEl("h4", { text: `${col.label} (${items.length})` });
      for (const t of items) this.renderCard(colEl, t);
    }

    // DAG del piano selezionato
    if (this.currentPlanId) {
      const dagEl = root.createDiv({ cls: "at-dag" });
      dagEl.createEl("h4", { text: "DAG" });
      try {
        const mermaid = await this.plugin.svc.graph(this.currentPlanId, "mermaid");
        await MarkdownRenderer.render(this.app, "```mermaid\n" + mermaid + "\n```", dagEl, "", this);
      } catch {
        /* ignore */
      }
    }

    root.scrollTop = prevScroll;
  }

  private renderCard(parent: HTMLElement, t: any) {
    const card = parent.createDiv({ cls: "at-card" });
    card.createEl("div", { cls: "at-key", text: `${t.task_key}  ·  ${t.worker_type || "?"}` });
    card.createEl("div", { cls: "at-title", text: t.title || "(senza titolo)" });
    const meta = card.createDiv({ cls: "at-meta" });
    if (t.worker) meta.createSpan({ text: `worker: ${t.worker}` });
    if (t.attempts) meta.createSpan({ text: ` · tent: ${t.attempts}` });
    if (t.process_score != null) meta.createSpan({ text: ` · score: ${t.process_score}` });
    if (t.error) card.createEl("div", { cls: "at-error", text: t.error });

    const actions = card.createDiv({ cls: "at-actions" });
    const act = async (fn: () => Promise<any>, ok: string) => {
      try {
        await fn();
        new Notice(ok);
        await this.render();
      } catch (e) {
        new Notice(`Errore: ${String((e as Error).message)}`);
      }
    };
    if (t.status === "AWAITING_APPROVAL") {
      actions.createEl("button", { text: "Approva" }).onclick = () => act(() => this.plugin.svc.approve(t.id), "approvato");
      actions.createEl("button", { text: "Rifiuta" }).onclick = () => act(() => this.plugin.svc.reject(t.id), "rifiutato");
    }
    if (t.status === "FAILED") {
      actions.createEl("button", { text: "Riprova" }).onclick = () => act(() => this.plugin.svc.retry(t.id), "in coda");
    }
  }

  private async createDemoPlan() {
    try {
      await this.plugin.svc.createPlan({
        spec: "piano demo",
        tasks: [
          { taskKey: "A", title: "Contesto", workerType: "CONTEXT_MANAGER" },
          { taskKey: "B", title: "Implementa BE", workerType: "BE", dependsOn: ["A"] },
          { taskKey: "C", title: "Review", workerType: "REVIEW", dependsOn: ["B"], requireApproval: true },
        ],
      });
      new Notice("piano demo creato");
    } catch (e) {
      new Notice(`Errore: ${String((e as Error).message)}`);
    }
  }
}
