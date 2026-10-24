# Performance ledger — 24 October 2026

Measurements use isolated Chromium, the same 1,736-record backup, 4× CPU throttling, and seven samples per run. These are synthetic main-thread operation timings, not real-user INP, Lighthouse, or measurements of the user's Windows computer. No uploaded records or images are included in the repository.

| Experiment | Median draft update | Median documents navigation | Verdict |
| --- | ---: | ---: | --- |
| Baseline | 11.5 ms | 950.2 ms | reference |
| Reuse Thai Intl date/number formatters | 11.2 ms | 449.3 ms | kept; much larger than sample variance |
| Reload device images only when configuration revision changes | 1.0 ms | 402.0 ms | kept for draft update; documents difference not attributed to this change |
| Generate only selected document grouping; skip second SVG recreation | 1.0 ms | 257.4 ms | kept for documents navigation |

Baseline attribution: fmtDate was called 2,204 times (~649 ms in an instrumented run), document rows generated twice (1,052 generated vs 526 displayed), and Lucide ran twice (~244 ms combined). The original per-draft device configuration clone took a median 8.4 ms. Measurements were repeated after each experiment under the same setup. Result: documents median ~73% lower, draft-update median ~91% lower; this is not a claim that every user interaction is that much faster.

Regression guards:

- `test_draft_edits_do_not_reload_unchanged_company_images` checks configuration isn't reloaded for ordinary draft changes but does update after a settings write.
- `test_document_group_modes_keep_rows_and_search` preserves all rows, grouping, search behavior and icons, including the default for an unknown legacy grouping value.
- Existing calculation, atomic-write and backup tests remain required.

JSON serialization/disk writing is deliberately outside the keystroke path. It happens only after explicit Save All. File System Access integration tests use real origin-private FileSystemFileHandles and intercepted pickers, including persistence after reload, revoked permission, write failure, cancellation and disconnect. A real Windows save dialog and physical disk were not controlled by these tests.

Further performance work should start with a fresh trace on the actual slow page/device. Document pagination and moving binary file data out of record snapshots remain possible future work; no work was silently dropped from the rendered document list.
