// Rendering del DAG del piano in mermaid (nodi colorati per stato) o JSON grezzo.
import { str } from "./util";
import type { Row } from "./types";

function mermaidLabel(v: any): string {
  return str(v, 80).replace(/["\[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim();
}
function mermaidId(v: any): string {
  return str(v, 40).replace(/[^A-Za-z0-9_]/g, "_") || "n";
}

const isHex = (c: any): boolean => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);
const classOf = (s: any): string => "s_" + String(s).replace(/[^A-Za-z0-9_]/g, "_");

export function renderGraph(
  items: Row[],
  deps: Row[],
  statusColors: Record<string, string>,
  format = "mermaid",
): string | { items: Row[]; deps: Row[] } {
  if (format === "json") return { items, deps };
  const colors = statusColors || {};
  const lines = ["graph TD"];
  // classDef per stato (colori dalla config) → nodi colorati come la board
  for (const [status, color] of Object.entries(colors)) {
    if (isHex(color)) lines.push(`  classDef ${classOf(status)} fill:${color},stroke:${color},color:#fff;`);
  }
  for (const i of items) {
    let node = `  ${mermaidId(i.task_key)}["${mermaidLabel(i.task_key + ": " + (i.title || ""))}"]`;
    if (isHex(colors[i.status])) node += `:::${classOf(i.status)}`;
    lines.push(node);
  }
  for (const d of deps) lines.push(`  ${mermaidId(d.depends_on)} --> ${mermaidId(d.task_key)}`);
  return lines.join("\n");
}
