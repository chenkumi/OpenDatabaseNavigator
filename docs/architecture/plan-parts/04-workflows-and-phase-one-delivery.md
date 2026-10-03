# Part 04 — Agent 工作流程與 Phase 1 交付

[← 回到計畫索引](../plan.md)

---

# 50. Agent 操作場景

一個非常自然的流程：

使用者正在看：

```text
orders
```

然後對 Agent 說：

```text
幫我看看最近失敗訂單為什麼變多。
```

Agent：

```text
app.get_state
```

知道目前：

```text
Database: shop
Table: orders
```

接著：

```text
table.describe
```

再：

```text
query.read
```

分析：

```text
status
created_at
payment_error
```

最後：

```text
app.open_query
```

將分析使用的 SQL 打開。

App 畫面：

```text
[ orders ] [ Agent Analysis ]
```

Human 與 Agent 在同一個 Workspace 工作。

這會比「單純讓 Agent 連 Database」有價值得多。

---

# 51. Phase 1 MCP Tools

第一階段建議控制在約 15～20 個核心能力。

```text
APP

app.get_state
app.list_tabs
app.open_query
app.open_table


CONNECTION

connection.list
connection.status
connection.connect


SCHEMA

database.list
schema.list
table.list
table.describe


QUERY

query.read
query.execute


DATA

data.select
data.insert
data.update
data.delete


REDIS

redis.scan
redis.get
redis.set
redis.delete
redis.ttl
redis.expire
```

實際 MCP `tools/list` 可以根據 Permission 動態控制。

---

# 52. Phase 1 MCP Resources

```text
app://workspace

app://connections

db://connection/{id}/schema

db://connection/{id}/table/{schema}/{table}
```

之後再加入：

```text
query://history

app://selection

db://connection/{id}/stats
```

---

# 53. Agent Control Indicator

當 MCP Server 啟動：

Status Bar：

```text
● MCP
```

Agent Connected：

```text
● MCP
1 Agent Connected
```

執行操作時：

```text
Claude is running a query...
```

讓使用者永遠知道 Agent 正在做什麼。

---

# 54. Remote Access Security

預設：

```text
Bind:
127.0.0.1

Remote:
Disabled
```

只有使用者開啟 Remote：

```text
Remote Access
ON
```

才開放外部。

Remote Access 建議：

```text
TLS

Authentication

Host Allowlist

Rate Limit

Permission Scope

Audit Log
```

---

# 55. Electron Architecture

建議：

```text
Electron Main

├── Application
│   ├── CommandBus
│   ├── EventBus
│   └── Services
│
├── Database
│   └── Adapters
│
├── MCP
│   ├── MCP Server
│   ├── Tools
│   ├── Resources
│   ├── Auth
│   ├── Permission
│   └── Audit
│
├── IPC
│
├── Security
│
└── Credential Storage
```

Renderer：

```text
React

├── Connections
├── Explorer
├── Workspace
├── SQL Editor
├── Data Table
├── Redis
├── Agent Activity
└── Settings
```

---

# 56. 建議 Folder Structure

```text
src/

├── main/
│
│   ├── application/
│   │   ├── commands/
│   │   ├── events/
│   │   └── services/
│   │
│   ├── database/
│   │   ├── adapters/
│   │   │   ├── sqlite/
│   │   │   ├── mysql/
│   │   │   ├── postgres/
│   │   │   ├── sqlserver/
│   │   │   └── redis/
│   │   │
│   │   └── connection/
│   │
│   ├── mcp/
│   │   ├── server/
│   │   ├── tools/
│   │   ├── resources/
│   │   ├── auth/
│   │   ├── permissions/
│   │   └── audit/
│   │
│   ├── ipc/
│   ├── security/
│   └── credentials/
│
├── preload/
│
├── renderer/
│
│   ├── features/
│   │   ├── connections/
│   │   ├── explorer/
│   │   ├── workspace/
│   │   ├── query/
│   │   ├── table/
│   │   ├── redis/
│   │   ├── agent/
│   │   └── settings/
│   │
│   └── components/
│
└── shared/
    ├── commands/
    ├── events/
    ├── schemas/
    ├── types/
    └── constants/
```

---

# 57. Phase 1 最終產品範圍

第一個可以正式使用的版本只需要完成：

```text
Desktop App

Connection Manager
       ↓
Database Explorer
       ↓
SQL Editor
       ↓
Query Result
       ↓
Table Browser
       ↓
Basic CRUD
       ↓
Redis Browser
```

以及：

```text
Agent

Remote MCP
       ↓
App Context
       ↓
Schema
       ↓
Query
       ↓
Data
       ↓
Workspace
```

---

# 58. 產品的核心差異

這套軟體不需要一開始就和 Navicat 比功能數量。

真正可以形成產品特色的是：

```text
Traditional Database Client

User
 ↓
Database Tool
 ↓
Database
```

變成：

```text
                 ┌──── User
                 │
                 ▼
              Workspace
                 ▲
                 │
                 └──── Agent

                    ↓

                 Database
```

也就是：

**Database Workspace 不只是「使用者操作 Database 的 GUI」，而是「Human + Agent 一起操作 Database 的工作環境」。**

這個方向會直接影響從第一天開始的架構設計，因此 MCP 不應該等 App 完成後才另外接上，而應該從 Phase 1 就把 Application Service、Command Bus、Permission 與 Event Bus 抽象好。
