# PAR-15292 spike: preparation phases of a chat run (throwaway, never merged)

Scripts used to measure the server preparation of a chat comment wake on an
isolated dev instance (`paperclipai worktree init --empty`, local_trusted).
The span collector (a preload that registers a file exporter) and the start
script are deliberately not committed.

- `setup.py`: company, 8 copied skills, Leo's instruction bundle, hermes_local agent, chat.
- `realism.py`: 32 secret env bindings (dummy values), 120 extra company skills.
- `fake-hermes.sh`: stand-in for `hermes chat` so runs end without a model call.
- `drive.py N`: posts N chat comments, waits for each run.
- `table.py`, `analyze.py`: per-phase table from spans, checked against run record and run log.
- `boundaries.py`, `live_split.py`: same four run-record boundaries on live (read only) and dev.

Results: comment on PAR-15292.
