import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatJobDuration, JOB_GLYPH } from "./background-jobs-tools.ts";
import type { RunningJobDisplay } from "./jobs-sidebar-state.ts";
import { CARD_TONE, panelExtraRows, panelInnerWidth, renderCard, type CardTheme } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

/** Running jobs only; the caller owns session scope and the elapsed clock. */
export function renderJobsCard(jobs: readonly RunningJobDisplay[], theme: CardTheme, width: number, now: number, maxRows: number): string[] {
	if (jobs.length === 0 || width <= 0) return [];
	const slots = Math.max(1, maxRows - panelExtraRows(theme, width));
	const listed = jobs.slice(0, jobs.length > slots ? slots - 1 : slots);
	const inner = panelInnerWidth(theme, width);
	const body = listed.map(job => {
		const elapsed = ` · ${formatJobDuration(now - job.startedAt)}`;
		const label = sanitizeTerminalText(job.label).replace(/\s+/g, " ");
		return truncateToWidth(`${truncateToWidth(label, Math.max(0, inner - elapsed.length), "…")}${elapsed}`, inner, "…");
	});
	if (listed.length < jobs.length) body.push(truncateToWidth(`… ${jobs.length - listed.length} more`, inner, "…"));
	return renderCard({ title: "Jobs", subtitle: `${jobs.length} running`, body, tone: CARD_TONE.INFO, glyph: JOB_GLYPH }, theme, width, { expanded: true, panel: true, hint: "click to view" });
}
