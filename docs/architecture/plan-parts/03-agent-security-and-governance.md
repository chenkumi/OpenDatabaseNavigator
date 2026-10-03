# Part 03 — Agent 安全與操作治理

[← 回到計畫索引](../plan.md)

---

# 40. Agent Approval System

Write 操作建議不要預設直接執行。

例如 Agent 想執行：

```sql
DELETE FROM users
WHERE id = 123;
```

App 出現：

```text
Agent Action Request

Agent wants to execute:

DELETE FROM users
WHERE id = 123

Connection:
Production

[Reject]

[Approve Once]

[Approve]
```

---

# 41. Approval Policy

Settings：

```text
Agent Actions

Read Query
✓ Allow

Open Table
✓ Allow

Open Query
✓ Allow

INSERT
Ask

UPDATE
Ask

DELETE
Ask

DDL
Deny

DROP
Deny
```

---

# 42. Destructive Operation

以下操作建議強制 User Approval：

```text
DROP DATABASE

DROP TABLE

TRUNCATE

DELETE without WHERE

UPDATE without WHERE

Redis FLUSHDB

Redis FLUSHALL
```

即使 Agent 擁有：

```text
Read + Write
```

也不能直接執行。

---

# 43. Agent Action Log

App 應該提供：

```text
Agent Activity
```

例如：

```text
12:01
Claude
Read public.users

12:02
Claude
Executed SELECT
32 rows

12:04
Claude
Requested UPDATE
Approved by User

12:04
UPDATE completed
1 row affected
```

---

# 44. Audit Log

記錄：

```text
Agent

Tool

Arguments Summary

Connection

Database

SQL

Result

Duration

User Approval

Timestamp
```

但不要記錄：

```text
Password

Token

SSH Secret
```

---

# 45. MCP Credential Isolation

Agent 永遠不能取得：

```text
Database Password

SSH Password

Private Key

Access Token
```

Agent 只能使用：

```text
connectionId
```

例如：

```text
postgres-production
```

App 自己從 Secure Storage 取得 credential。

---

# 46. Credential Architecture

例如：

```text
Agent

↓

connectionId

↓

ConnectionService

↓

CredentialService

↓

Electron safeStorage

↓

Database Driver
```

Agent 永遠看不到 Credential。

---

# 47. MCP Tool Design 原則

不要建立數百個 Tools。

Tool 要：

```text
Semantic

Stable

Structured

Predictable
```

例如：

GOOD：

```text
table.describe

query.read

data.update

app.open_table
```

不建議：

```text
click_button

click_tree_node

press_key

move_mouse
```

Agent 應該操作「App Capability」，不是模擬滑鼠。

---

# 48. MCP Tool Result

結果盡量使用 Structured Data。

例如：

```json
{
  "success": true,
  "rowCount": 3,
  "columns": [
    "id",
    "name"
  ],
  "rows": [
    [
      1,
      "Kevin"
    ],
    [
      2,
      "Alice"
    ]
  ]
}
```

不要只回：

```text
Query successful
```

Agent 才能繼續推理。

---

# 49. Large Query Result

避免 MCP 一次傳：

```text
100,000 rows
```

必須有：

```text
limit

cursor

pagination
```

例如：

```json
{
  "rows": [],
  "nextCursor": "xxxx",
  "hasMore": true
}
```

App GUI 同樣採用類似概念。

---
