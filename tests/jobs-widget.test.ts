import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderJobsCard } from "../lib/jobs-widget.ts";
import { CARD_STYLE, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `job-${i}`, label: `Build ${i}`, startedAt: 0 }));

test("Jobs card is empty without running jobs and shows labels and elapsed time", () => {
	assert.deepEqual(renderJobsCard([], theme, 80, 5000, 8), []);
	const screen = renderJobsCard(jobs.slice(0, 1), theme, 80, 5000, 8).join("\n");
	assert.match(screen, /Jobs.*1 running/);
	assert.match(screen, /Build 0.*5s/);
});

test("Jobs card bounds rows and terminal text in both card styles", () => {
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const width of [1, 12, 40, 80]) {
				const rows = renderJobsCard([{ ...jobs[0], label: "unsafe\x1b[2J\nlabel\t".repeat(20) }, ...jobs], theme, width, 5000, 5);
				assert.ok(rows.length <= 7, `${style} at ${width}: ${rows.length} rows`);
				assert.ok(rows.every(row => visibleWidth(row) <= width && !/[\n\t]/.test(stripAnsi(row)) && !row.includes("\x1b[2J")));
				if (width === 80) assert.match(rows.join("\n"), /more/);
			}
		}
	} finally { setCardStyle(CARD_STYLE.FLOAT); }
});
