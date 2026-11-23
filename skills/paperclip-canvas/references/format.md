# Canvas format and ops

## Reading

`GET /api/companies/{companyId}/planning-canvases/{boardId}`

| Query | Meaning |
|---|---|
| `format` | `json` (default), `markdown`, `mermaid`. Text formats carry the `X-Planning-Canvas-Revision` header. |
| `since` | Revision number. Only items changed after it. A purged range answers `{ "resync": true }`: re-read the whole board. |
| `keys` | Comma-separated item keys. |
| `area` | `x,y,width,height`: items inside this rectangle. |
| `q` | Text search (max 200 characters). |

List: `GET .../planning-canvases?scope=personal|project|company&projectId=<uuid>&archived=true`.

## Items

Every item has a `key` (1-100 characters), a `version` (rises on each change) and a `type`:

- node: `{ itemType: "node", key, kind, x, y, width, height, zIndex, color, title, content, data?, ref?, links? }`. `zIndex` (int), `color` (yellow|amber|blue|emerald|rose|violet|slate), `title` (max 300) and `content` (max 20,000; use "" when unused) are required on every node. Give a new result node a higher `zIndex` than the source so it is not hidden.
- connector: `{ itemType: "connector", key, fromKey, toKey }`
- stroke: freehand drawing, usually not edited by agents.

Node kinds and `data`:

- `sticky`, `note`, `text`, `frame`, `shape`: the text lives in `title` and `content` (they take no `data`). `shape` kinds may set `shape`.
- `issue`, `agent`, `project`, `goal`: `ref: { id }`. `links` is `[{ type: "issue", issueId }]` (max 50).
- `table`: `{ columns: [{ id, name, type: text|number|status|person|date }], rows: [{ id, cells: { <colId>: value } }] }` (max 50 columns, 500 rows).
- `kanban`: `{ source: IssueQuery, groupBy: status|assignee|priority, collapsed: [] }`.
- `timeline`: `{ source: IssueQuery | { kind: "projects" }, scale: day|week|month, range?: { from, to } }`.
- `markdown`: `{ markdown }` (max 50,000 characters).
- `IssueQuery`: `{ kind: "issues", filter: { projectId?, goalId?, assigneeAgentId?, parentId?, status?: [] }, limit <= 200 }`.

Limits: 64 KB per item, 500 ops per batch.

## Writing

`POST .../{boardId}/ops`

```json
{
  "clientBatchId": "run-123-step-1",
  "atomic": false,
  "ops": [
    { "op": "add", "item": { "itemType": "node", "key": "plan-result", "kind": "markdown", "x": 600, "y": 100, "width": 360, "height": 240, "zIndex": 10, "color": "blue", "title": "Result", "content": "", "data": { "markdown": "## Result\n- point" } } },
    { "op": "add", "item": { "itemType": "connector", "key": "c-source-result", "fromKey": "source-node", "toKey": "plan-result" } },
    { "op": "update", "key": "source-node", "baseVersion": 4, "set": { "content": "new text" } },
    { "op": "table.setCell", "key": "budget-table", "rowId": "r1", "colId": "c1", "value": "Done" },
    { "op": "table.addRow", "key": "budget-table", "row": { "id": "r2", "cells": { "c1": "Todo" } }, "index": 1 },
    { "op": "table.addColumn", "key": "budget-table", "column": { "id": "c2", "name": "Owner", "type": "person" } },
    { "op": "table.moveRow", "key": "budget-table", "rowId": "r2", "toIndex": 0 },
    { "op": "table.removeRow", "key": "budget-table", "rowId": "r2" },
    { "op": "table.removeColumn", "key": "budget-table", "colId": "c2" },
    { "op": "delete", "key": "old-note", "baseVersion": 1 },
    { "op": "restore", "key": "old-note" }
  ]
}
```

Only `update` and `delete` take `baseVersion`. Table ops take `key` plus their own fields and no `baseVersion`: `setCell` (`rowId`, `colId`, `value`), `addRow` (`row`, optional `index`), `removeRow` (`rowId`), `addColumn` (`column`, optional `index`), `removeColumn` (`colId`), `moveRow` (`rowId`, `toIndex`). A table `update` with `set.data` replaces the whole table: avoid it.

Deleting a node also removes the connectors attached to it; `restore` brings them back if the other end still exists.

## Results

One result per op:

- `{ "status": "applied", key, version, revision }`
- `{ "status": "conflict", key, current, conflictingFields }`: someone changed the same fields. Re-read, merge, re-send with `current.version`.
- `{ "status": "rejected", key, reason }`: the op is invalid or not allowed. Fix it; do not retry unchanged.

Same `clientBatchId` from the same caller returns the first answer, so a retry after a timeout is safe.

## Comments and sharing

- `GET|POST .../{boardId}/comments` (`itemKey` for a node thread, `parentId` to reply), `POST .../comments/{commentId}/resolve`.
- `PATCH .../{boardId}/sharing`, `GET|DELETE .../{boardId}/agent-grants[/{grantId}]`: owner and admin matters. Agents do not change sharing or grants.
