import type { Component } from "vue";
import { Eye, Table2 } from "lucide-vue-next";

/**
 * The glyph a table-like object wears, in DBX's palette: green tables, purple
 * views, indigo materialized views. `type` is the driver's own string, so the
 * two view spellings are matched exactly and every other value — including a
 * partitioned or foreign table — keeps the table's hue.
 */
export function tableGlyph(type: string): { icon: Component; iconClass: string } {
	if (type === "view") return { icon: Eye, iconClass: "text-purple-500" };
	if (type === "materialized view") return { icon: Eye, iconClass: "text-indigo-500" };
	return { icon: Table2, iconClass: "text-green-500" };
}
