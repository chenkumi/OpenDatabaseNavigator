# Part 02 — MCP 架構與 Agent 能力

[← 回到計畫索引](../plan.md)

---

# 21. MCP 是 App 的正式 Interface

MCP 不應該只是另外開一個：

```text
executeSQL()
```

而是把 App 的能力正式抽象成 Agent API。

架構：

```text
Agent

  ↓

Remote MCP Server

  ↓

MCP Tool Layer

  ↓

Permission Layer

  ↓

Application Command Bus

  ↓

Application Services

  ↓

Database Adapter
```

這代表 Agent 實際操作的是：

```text
App Capability
```

而不是：

```text
Database Driver
```

---

# 22. Remote MCP Server

App 啟動後，可以選擇啟動：

```text
MCP Server
```

Endpoint：

```text
https://host/mcp
```

Remote MCP 採：

```text
Streamable HTTP
```

目前 MCP 官方遠端 transport 以 Streamable HTTP 為主要方向，舊 SSE transport 已不是新系統應優先採用的方案。

---

# 23. MCP Settings

設定頁面：

```text
Agent Access

[ ] Enable MCP Server

Listen:
127.0.0.1

Port:
7799

Remote Access:
OFF

Authentication:
Enabled

Agent Permissions:
Read Only
```

預設：

```text
MCP Disabled
```

使用者主動開啟。

---

# 24. Local MCP 與 Remote MCP

提供兩種模式。

## Local

```text
127.0.0.1:7799
```

適合：

- Local Agent
- IDE Agent
- Desktop Agent

安全性最高。

## Remote

例如：

```text
https://db.example.com/mcp
```

適合遠端 Agent。

開啟 Remote Access 時才允許：

```text
0.0.0.0
```

或指定 Network Interface。

本機 HTTP Server 應保留 Host allowlist / DNS rebinding 防護；官方 SDK 也特別提供 localhost Host validation 機制。

---

# 25. MCP Authentication

Local 模式可以提供：

```text
Local Access Token
```

Remote 模式則設計支援：

```text
OAuth
Bearer Token
```

目前 MCP 遠端授權設計可使用 OAuth bearer token，由 MCP Server 作為 Resource Server 驗證 token。

Phase 1 可以先：

```text
Generated Access Token
```

例如：

```text
mcp_xxxxxxxxxxxxxxxxx
```

後續再加入完整 OAuth。

---

# 26. MCP Permission Model

這個部分非常重要。

每個 Connection 都可以設定：

```text
Agent Access

○ Disabled

○ Read Only

○ Read + Write
```

例如：

```text
Local PostgreSQL
Agent: Read + Write

Production PostgreSQL
Agent: Read Only
```

---

# 27. MCP Permission Levels

建議三層：

```text
Observe

Assist

Execute
```

## Observe

Agent 可以：

- 看 Connection
- 看 Schema
- 看 Table
- 看 Workspace
- SELECT
- Redis GET

不能修改。

## Assist

可以：

- 開 Tab
- 建 Query
- 填 SQL
- 顯示 Table
- 顯示 Query Result

但 Database Write 需要 User Approve。

## Execute

允許：

- INSERT
- UPDATE
- DELETE
- Redis SET

但 Destructive Operation 仍然需要額外 Permission。

---

# 28. MCP Tools — App

Agent 應該可以操作 App 本身。

例如：

```text
app.get_state
```

取得：

```json
{
  "activeConnection": "postgres-local",
  "activeDatabase": "mydb",
  "activeTab": "query-123"
}
```

---

Agent 可以：

```text
app.list_tabs
```

---

```text
app.open_query
```

例如：

```json
{
  "connectionId": "postgres-local",
  "sql": "SELECT * FROM users"
}
```

App GUI 立即出現新的 Query Tab。

---

```text
app.open_table
```

例如：

```json
{
  "connectionId": "postgres-local",
  "schema": "public",
  "table": "users"
}
```

App UI 自動開啟：

```text
users
```

---

# 29. MCP Tools — Connection

例如：

```text
connection.list
```

回傳：

```text
Local PostgreSQL
Local Redis
Development MySQL
```

但是：

**絕對不回傳 Password。**

---

```text
connection.status
```

---

```text
connection.connect
```

---

```text
connection.disconnect
```

---

# 30. MCP Tools — Schema

例如：

```text
database.list
```

---

```text
schema.list
```

---

```text
table.list
```

---

```text
table.describe
```

例如：

```json
{
  "connectionId": "postgres-local",
  "schema": "public",
  "table": "users"
}
```

回傳：

```text
id bigint PK
name varchar
email varchar
created_at timestamp
```

---

# 31. MCP Tools — Query

不建議只有：

```text
execute_sql
```

應該拆分權限。

例如：

```text
query.read
```

專門處理：

```sql
SELECT
EXPLAIN
```

---

Write 使用：

```text
query.execute
```

需要較高權限。

---

建議另外提供：

```text
query.validate
```

Agent 可以先要求 App 分析 SQL。

例如：

```text
Read Query

Write Query

DDL

Potentially Destructive
```

---

# 32. MCP Query Example

Agent：

```text
table.describe
```

取得：

```text
users
orders
```

接著：

```text
query.read
```

```sql
SELECT
    u.name,
    COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o
ON o.user_id = u.id
GROUP BY u.id
ORDER BY orders DESC
LIMIT 10;
```

App 執行。

結果：

```text
Kevin  152
Alice  138
Bob    120
```

Agent 同時可以要求：

```text
showInApp: true
```

App 自動開啟 Query Result。

---

# 33. MCP Tools — Data

可以提供更高階的 API：

```text
data.select
```

例如：

```json
{
  "table": "users",
  "columns": [
    "id",
    "name",
    "email"
  ],
  "limit": 100
}
```

Agent 不一定每次都需要自己產 SQL。

---

Write：

```text
data.insert
```

```text
data.update
```

```text
data.delete
```

這樣 Permission 比直接任意 SQL 更容易控制。

---

# 34. MCP Tools — Redis

Read：

```text
redis.scan
redis.get
redis.hgetall
redis.lrange
redis.smembers
redis.zrange
redis.ttl
```

Write：

```text
redis.set
redis.hset
redis.delete
redis.expire
```

同樣區分 Read / Write Permission。

---

# 35. MCP Resources

MCP 的 Resource 非常適合提供 Agent Database Context。

Resources 適合暴露資料與上下文，而 Tool 則處理實際 Action。

例如：

```text
app://workspace
```

取得目前 Workspace。

---

```text
app://connections
```

---

```text
db://connection/{connectionId}/schema
```

---

```text
db://connection/{connectionId}/table/{schema}/{table}
```

---

例如：

```text
db://connection/postgres-local/table/public/users
```

內容：

```json
{
  "table": "users",
  "columns": [
    {
      "name": "id",
      "type": "bigint",
      "primaryKey": true
    },
    {
      "name": "email",
      "type": "varchar"
    }
  ]
}
```

---

# 36. Agent Context

這個 App 可以提供一個非常重要的概念：

```text
Current App Context
```

例如：

```json
{
  "activeConnection": "development-postgres",
  "database": "shop",
  "schema": "public",
  "activeTable": "orders",
  "selectedRows": [1001, 1002],
  "activeQueryTab": "query-12"
}
```

Agent 就可以理解：

> 「使用者目前正在看 orders。」

因此使用者可以直接對 Agent 說：

```text
幫我看看這個 Table 有什麼問題
```

而不用再次解釋：

```text
哪個 Server
哪個 Database
哪個 Schema
哪個 Table
```

這會是產品非常重要的體驗。

---

# 37. GUI 與 Agent 同步

Agent 操作 App 時，UI 應該有可見反應。

例如 Agent 呼叫：

```text
app.open_table(users)
```

GUI：

```text
[ users ]
```

立即出現。

Agent 呼叫：

```text
app.open_query(sql)
```

GUI：

```text
[ Query 3 ]
```

自動開啟。

因此 Agent 並不是偷偷操作 Database。

而是：

```text
Agent
   ↓
Application Command
   ↓
Database
   +
Workspace Event
   ↓
GUI
```

---

# 38. Command Bus

建議建立：

```text
ApplicationCommandBus
```

例如：

```text
OpenTableCommand

OpenQueryCommand

ExecuteQueryCommand

UpdateRowCommand

DeleteRowCommand

SetRedisValueCommand
```

Human：

```text
React
  ↓
IPC
  ↓
CommandBus
```

Agent：

```text
MCP
  ↓
CommandBus
```

最後完全共用。

---

# 39. Event Bus

Application Service 執行後產生 Event。

例如：

```text
QueryExecuted

TableOpened

RowUpdated

ConnectionChanged

TabCreated
```

Renderer 可以 Subscribe。

例如：

```text
Agent

↓ MCP

OpenTableCommand

↓

WorkspaceService

↓

TableOpened Event

↓

Electron Renderer

↓

Open users Tab
```

---
