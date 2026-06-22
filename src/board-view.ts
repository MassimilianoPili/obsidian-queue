import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, Menu, App, Setting } from "obsidian";
import type AgentTasksPlugin from "./main";

export const VIEW_TYPE_TASKS = "agent-tasks-board";

// conferma per azioni distruttive (eliminazione task)
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private message: string,
    private onConfirm: () => Promise<void> | void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Elimina").setWarning().onClick(async () => {
          await this.onConfirm();
          this.close();
        }),
      )
      .addButton((b) => b.setButtonText("Annulla").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Modal di modifica metadati di un task (NON lo stato: quello passa per la macchina a stati).
class TaskEditModal extends Modal {
  constructor(
    app: App,
    private task: any,
    private taskTypes: string[],
    private onSave: (patch: any) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Modifica ${this.task.task_key}` });

    let title = this.task.title || "";
    let priority = String(this.task.priority ?? 5);
    let tags = "";
    try {
      tags = (JSON.parse(this.task.tags || "[]") as string[]).join(", ");
    } catch { /* tag malformati */ }
    let maxAttempts = String(this.task.max_attempts ?? 3);
    let workerType = this.task.worker_type || "";

    new Setting(contentEl).setName("Titolo").addText((t) => t.setValue(title).onChange((v) => (title = v)));
    new Setting(contentEl).setName("Priorità (1-10)").addText((t) => t.setValue(priority).onChange((v) => (priority = v)));
    new Setting(contentEl).setName("Tag (separati da virgola)").addText((t) => t.setValue(tags).onChange((v) => (tags = v)));
    new Setting(contentEl).setName("Max tentativi").addText((t) => t.setValue(maxAttempts).onChange((v) => (maxAttempts = v)));
    // tipo: se la config definisce un vocabolario (taskTypes) usa una tendina, altrimenti testo libero
    const typeSetting = new Setting(contentEl).setName("Tipo (worker_type)");
    if (this.taskTypes.length) {
      typeSetting.addDropdown((d) => {
        d.addOption("", "(nessuno)");
        const opts = [...this.taskTypes];
        if (workerType && !opts.includes(workerType)) opts.push(workerType); // preserva valore fuori vocabolario
        for (const tt of opts) d.addOption(tt, tt);
        d.setValue(workerType).onChange((v) => (workerType = v));
      });
    } else {
      typeSetting.addText((t) => t.setValue(workerType).onChange((v) => (workerType = v)));
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Salva").setCta().onClick(async () => {
          const patch: any = {
            itemId: this.task.id,
            title,
            priority: Number(priority),
            maxAttempts: Number(maxAttempts),
            workerType,
            tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
          };
          try {
            await this.onSave(patch);
            new Notice("task aggiornato");
            this.close();
          } catch (e) {
            new Notice(`Errore: ${String((e as Error).message)}`);
          }
        }),
      )
      .addButton((b) => b.setButtonText("Annulla").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class TasksBoardView extends ItemView {
  private refreshTimer: number | null = null;
  private currentPlanId = "";
  private boardEl: HTMLElement | null = null;
  private planSelect: HTMLSelectElement | null = null;
  private sqlInput: HTMLInputElement | null = null;
  private sqlResultsEl: HTMLElement | null = null;
  private lastPlanIdsKey = "";
  private lastTasksHash = "";

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
    return this.plugin.config?.labels?.viewTitle || "Task Queue";
  }
  getIcon() {
    return "list-checks";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("agent-tasks-root");
    // chrome PERSISTENTE: toolbar + barra SQL non vengono ricostruiti dal timer →
    // la tendina dei piani non si richiude più e l'input SQL non perde focus.
    const chrome = root.createDiv({ cls: "at-chrome" });
    this.buildToolbar(chrome);
    this.buildSqlBar(chrome);
    // contenitore board dinamico, ridisegnato dal timer (solo se i dati cambiano)
    this.boardEl = root.createDiv({ cls: "at-boardwrap" });
    this.refreshTimer = window.setInterval(() => void this.renderBoard(), 2000);
    await this.renderBoard(true);
  }

  async onClose() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }

  // ── toolbar persistente ─────────────────────────────────────────────────────
  private buildToolbar(parent: HTMLElement) {
    const toolbar = parent.createDiv({ cls: "at-toolbar" });
    toolbar.createEl("button", { text: "Aggiorna" }).onclick = () => void this.renderBoard(true);
    const sel = toolbar.createEl("select");
    sel.createEl("option", { text: "Tutti i piani", value: "" });
    sel.onchange = () => {
      this.currentPlanId = sel.value;
      void this.renderBoard(true);
    };
    this.planSelect = sel;
  }

  // aggiorna le opzioni del selettore SOLO se l'insieme dei piani cambia e non è aperto (focus).
  private syncPlanSelector(planIds: string[]) {
    const sel = this.planSelect;
    if (!sel) return;
    const key = planIds.join(",");
    if (key === this.lastPlanIdsKey) return;
    if (document.activeElement === sel) return; // non toccarlo mentre l'utente lo sta usando
    this.lastPlanIdsKey = key;
    sel.empty();
    sel.createEl("option", { text: "Tutti i piani", value: "" });
    for (const pid of planIds) sel.createEl("option", { text: pid.slice(0, 8), value: pid });
    if (this.currentPlanId && !planIds.includes(this.currentPlanId)) this.currentPlanId = "";
    sel.value = this.currentPlanId;
  }

  // ── barra SQL read-only (filtra/verifica) ───────────────────────────────────
  private buildSqlBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "at-sqlbar" });
    const input = bar.createEl("input", {
      cls: "at-sql-input",
      attr: {
        type: "text",
        placeholder: "SELECT task_key, status, priority, tags FROM plan_items ORDER BY status",
      },
    });
    this.sqlInput = input;
    const run = () => void this.runQuery();
    bar.createEl("button", { text: "Esegui SQL" }).onclick = run;
    bar.createEl("button", { text: "Pulisci" }).onclick = () => {
      input.value = "";
      if (this.sqlResultsEl) this.sqlResultsEl.empty();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });
    this.sqlResultsEl = parent.createDiv({ cls: "at-sql-results" });
  }

  private async runQuery() {
    const el = this.sqlResultsEl;
    if (!el) return;
    const sql = (this.sqlInput?.value || "").trim();
    el.empty();
    if (!sql) return;
    try {
      const res: any = await this.plugin.svc.query({ sql, limit: 500 });
      const cols: string[] = res.columns || [];
      const rows: any[] = res.rows || [];
      const meta = el.createDiv({ cls: "at-sql-meta" });
      meta.setText(`${res.count} righe${res.truncated ? " (troncate a 500)" : ""}`);
      if (!rows.length) return;
      const table = el.createEl("table", { cls: "at-sql-table" });
      const thead = table.createEl("thead").createEl("tr");
      for (const c of cols) thead.createEl("th", { text: c });
      const tbody = table.createEl("tbody");
      for (const r of rows) {
        const tr = tbody.createEl("tr");
        for (const c of cols) {
          const v = r[c];
          tr.createEl("td", { text: v == null ? "" : String(v) });
        }
      }
    } catch (e) {
      el.createDiv({ cls: "at-error", text: `Errore SQL: ${String((e as Error).message)}` });
    }
  }

  // ── board dinamico (rebuild solo quando i dati cambiano) ─────────────────────
  private async renderBoard(force = false) {
    const root = this.boardEl;
    if (!root) return;
    let tasks: any[] = [];
    try {
      tasks = (await this.plugin.svc.listTasks({})) || [];
    } catch (e) {
      root.empty();
      root.createEl("p", { text: `Servizio non pronto: ${String((e as Error).message)}` });
      this.lastTasksHash = "";
      return;
    }

    const planIds = [...new Set(tasks.map((t) => t.plan_id))];
    this.syncPlanSelector(planIds);

    // evita il flicker e di chiudere interazioni: ridisegna solo se cambia qualcosa
    const hash = JSON.stringify(tasks) + "|" + this.currentPlanId;
    if (!force && hash === this.lastTasksHash) return;
    this.lastTasksHash = hash;

    const prevScroll = root.scrollTop;
    root.empty();

    const shown = this.currentPlanId ? tasks.filter((t) => t.plan_id === this.currentPlanId) : tasks;

    const board = root.createDiv({ cls: "at-board" });
    for (const col of this.plugin.config.labels.columns) {
      const colEl = board.createDiv({ cls: "at-col" });
      colEl.style.setProperty("--at-accent", this.statusColor(col.status));
      const items = shown.filter((t) => t.status === col.status);
      const head = colEl.createDiv({ cls: "at-colhead" });
      head.createSpan({ cls: "at-collabel", text: col.label });
      head.createSpan({ cls: "at-count", text: String(items.length) });
      const list = colEl.createDiv({ cls: "at-collist" });
      for (const t of items) this.renderCard(list, t);
    }

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

  // colore d'accento per stato: config-driven (statusColors in queue.config.json).
  // Stesso colore usato dai nodi del DAG. Stati non mappati → neutro.
  private statusColor(status: string): string {
    return this.plugin.config.statusColors?.[status] || "var(--text-muted)";
  }

  private renderCard(parent: HTMLElement, t: any) {
    const card = parent.createDiv({ cls: "at-card" });
    card.style.setProperty("--at-accent", this.statusColor(t.status));

    const head = card.createDiv({ cls: "at-head" });
    head.createSpan({ cls: "at-key", text: t.task_key });
    if (t.worker_type) head.createSpan({ cls: "at-type", text: t.worker_type });

    card.createEl("div", { cls: "at-title", text: t.title || "(senza titolo)" });

    const meta = card.createDiv({ cls: "at-meta" });
    const prio = Number(t.priority) || 5;
    const prioCls = prio <= 3 ? "hi" : prio <= 6 ? "mid" : "lo";
    const pr = meta.createSpan({ cls: `at-prio at-prio-${prioCls}` });
    pr.createSpan({ cls: "at-dot" });
    pr.createSpan({ text: `P${prio}` });
    if (t.worker) meta.createSpan({ cls: "at-mi", text: t.worker });
    if (t.attempts) meta.createSpan({ cls: "at-mi", text: `↻ ${t.attempts}/${t.max_attempts ?? "?"}` });
    if (t.next_eligible_at) {
      const inS = t.next_eligible_at - Math.floor(Date.now() / 1000);
      if (inS > 0) meta.createSpan({ cls: "at-mi", text: `⏱ ${inS}s` });
    }

    if (t.tags) {
      try {
        const tags: string[] = JSON.parse(t.tags);
        if (tags.length) {
          const tw = card.createDiv({ cls: "at-tagwrap" });
          for (const tag of tags) tw.createSpan({ cls: "at-chip", text: tag });
        }
      } catch { /* ignore malformed tags */ }
    }
    if (t.error) card.createEl("div", { cls: "at-error", text: t.error });

    // tutte le azioni in un menu contestuale: niente overflow di pulsanti sulla card.
    // apribile col tasto destro sulla card o col pulsante "⋯".
    const actions = card.createDiv({ cls: "at-actions" });
    const moreBtn = actions.createEl("button", { cls: "at-more", text: "⋯ Azioni" });
    moreBtn.onclick = (e) => this.openCardMenu(t, e as MouseEvent);
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCardMenu(t, e);
    });
  }

  private openCardMenu(t: any, evt: MouseEvent) {
    const sm = this.plugin.config.stateMachine;
    const labelOf = (status: string) =>
      this.plugin.config.labels.columns.find((c) => c.status === status)?.label || status;
    const act = async (fn: () => Promise<any>, ok: string) => {
      try {
        await fn();
        new Notice(ok);
        await this.renderBoard(true);
      } catch (e) {
        new Notice(`Errore: ${String((e as Error).message)}`);
      }
    };

    const menu = new Menu();

    if (t.status === sm.approvalState) {
      menu.addItem((i) => i.setTitle("Approva").setIcon("check").onClick(() => act(() => this.plugin.svc.approve(t.id), "approvato")));
      menu.addItem((i) => i.setTitle("Rifiuta").setIcon("x").onClick(() => act(() => this.plugin.svc.reject(t.id), "rifiutato")));
    }
    if (t.status === sm.failureState || t.status === sm.deadLetterState) {
      menu.addItem((i) => i.setTitle("Riprova").setIcon("rotate-ccw").onClick(() => act(() => this.plugin.svc.retry(t.id), "in coda")));
    }
    // spostamenti manuali: una voce per ogni transizione legale non già coperta sopra
    const handled = new Set<string>([
      `${sm.approvalState}→${sm.initial}`,
      `${sm.approvalState}→${sm.failureState}`,
      `${sm.failureState}→${sm.claimableState}`,
      `${sm.deadLetterState}→${sm.claimableState}`,
    ]);
    const targets = (sm.transitions[t.status] || []).filter((to) => !handled.has(`${t.status}→${to}`));
    for (const to of targets) {
      menu.addItem((i) =>
        i.setTitle(`Sposta → ${labelOf(to)}`).setIcon("arrow-right").onClick(() =>
          act(() => this.plugin.svc.moveTask({ itemId: t.id, to }), `→ ${labelOf(to)}`),
        ),
      );
    }

    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Modifica").setIcon("pencil").onClick(() => {
        new TaskEditModal(this.app, t, this.plugin.config.taskTypes || [], async (patch) => {
          await this.plugin.svc.updateTask(patch);
          await this.renderBoard(true);
        }).open();
      }),
    );
    menu.addItem((i) =>
      i.setTitle("Elimina").setIcon("trash").onClick(() => {
        new ConfirmModal(this.app, `Eliminare il task ${t.task_key}?`, () =>
          act(() => this.plugin.svc.deleteTask({ itemId: t.id }), "eliminato"),
        ).open();
      }),
    );

    menu.showAtMouseEvent(evt);
  }
}
