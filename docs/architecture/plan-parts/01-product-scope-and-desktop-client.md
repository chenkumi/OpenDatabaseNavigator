# Part 01 — 產品定位與桌面資料庫功能

[← 回到計畫索引](../plan.md)

---

# 1. 產品定位

本產品是一套跨平台 Desktop Database Client。

主要特色不是完整複製 Navicat，而是：

**簡單、快速、現代化、Agent Friendly。**

主要使用情境分成兩種：

```text
Human
  ↓
Desktop GUI
  ↓
Database

Agent
  ↓
Remote MCP
  ↓
Desktop App
  ↓
Database
```

因此 App 同時具有兩個角色：

### 角色 A — Database Desktop Client

讓使用者操作：

- SQLite
- MySQL / MariaDB
- PostgreSQL
- SQL Server
- Redis

### 角色 B — Agent Database Gateway

讓 AI Agent 可以：

- 查看目前 App 狀態
- 查看 Database Schema
- 查看 Table Structure
- 執行 SQL
- 查詢資料
- 開啟 Table
- 開啟 SQL Editor
- 建立 Query Tab
- 將查詢結果顯示在 App
- 修改資料
- 操作 Redis
- 與使用者共享同一個 Workspace

---

# 2. Phase 1 設計原則

第一階段不追求 Navicat 的完整功能。

核心原則：

```text
Basic
Fast
Friendly
Safe
Agent Ready
```

優先做好：

1. Connection
2. Database Explorer
3. SQL Editor
4. Data Table
5. Basic CRUD
6. Redis Browser
7. Workspace Tabs
8. MCP Agent Interface

暫時不做：

- ER Diagram
- Database Compare
- Schema Migration
- Backup / Restore
- Stored Procedure Designer
- Trigger Designer
- Database Monitoring
- Advanced DBA Tools
- Query Profiler
- Visual Query Builder
- Complex Import / Export Wizard

這些全部留到後續版本。

---

# 3. 核心架構

最重要的架構原則：

**Renderer 與 MCP 都不能直接操作 Database Driver。**

整體架構：

```text
                         ┌──────────────────────┐
                         │      Human User      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ React / Electron UI  │
                         └──────────┬───────────┘
                                    │ IPC
                                    │
                                    ▼
┌──────────────┐        ┌────────────────────────────┐
│ AI Agent     │        │                            │
│ Claude /     │        │    Application Services    │
│ ChatGPT /    │──MCP──▶│                            │
│ Codex / etc  │        │      Command Bus           │
└──────────────┘        │      Query Service         │
                        │      Schema Service        │
                        │      Data Service          │
                        │      Workspace Service     │
                        └──────────────┬─────────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │   Database Adapters    │
                          ├────────────────────────┤
                          │ SQLite                 │
                          │ MySQL                  │
                          │ PostgreSQL             │
                          │ SQL Server             │
                          │ Redis                  │
                          └────────────┬───────────┘
                                       │
                                       ▼
                                   Database
```

Human 與 Agent 共用：

```text
Application Service
```

而不是：

```text
GUI → Driver

MCP → Driver
```

---

# 4. App Service Layer

建立統一 Application API。

例如：

```text
ConnectionService

SchemaService

QueryService

DataService

RedisService

WorkspaceService

PermissionService

AuditService
```

GUI 與 MCP 都使用這些 Service。

---

# 5. Connection Management

Phase 1 支援：

```text
SQLite
MySQL
PostgreSQL
SQL Server
Redis
```

使用者可以：

- New Connection
- Edit Connection
- Delete Connection
- Test Connection
- Connect
- Disconnect
- Reconnect

基本 Connection 欄位：

```text
Name

Host
Port
Username
Password

Database
```

SQLite：

```text
Database File
```

Redis：

```text
Host
Port
Username
Password
DB Index
```

---

# 6. Connection Sidebar

左側顯示所有 Connections。

例如：

```text
Connections

▾ Local
   PostgreSQL
   MySQL

▾ Production
   PostgreSQL Production

▾ Redis
   Local Redis
```

支援：

- Group
- Favorite
- Connection Color
- Search

---

# 7. Database Explorer

Connection 展開後顯示 Database Metadata。

例如 PostgreSQL：

```text
PostgreSQL

▾ my_database
   ▾ public
      ▾ Tables
         users
         orders
         products

      ▾ Views
```

MySQL：

```text
MySQL

▾ shop
   ▾ Tables
   ▾ Views
```

SQLite：

```text
SQLite

▾ Tables
▾ Views
```

Phase 1 Explorer 只需要：

- Database
- Schema
- Table
- View
- Column

不用一開始處理大量 DBA Object。

---

# 8. Workspace

主要操作都開啟成 Tab。

例如：

```text
[ users ] [ orders ] [ Query 1 ] [ Query 2 ]
```

支援：

- Open Tab
- Close Tab
- Close Others
- Tab Reorder
- Dirty Indicator

Tab 類型：

```text
Table
Query
Redis
```

第一階段保持簡單。

---

# 9. SQL Editor

使用：

```text
Monaco Editor
```

Phase 1 功能：

- SQL Syntax Highlight
- Line Number
- Auto Indent
- Find / Replace
- Basic Autocomplete
- Execute SQL
- Execute Selection
- Stop Query

快捷鍵：

```text
Cmd / Ctrl + Enter
```

---

# 10. SQL Autocomplete

Autocomplete 可以使用 Schema Metadata。

例如：

```sql
SELECT *
FROM users u
WHERE u.
```

顯示：

```text
id
name
email
created_at
```

第一階段只需要完成：

- Table
- Column
- SQL Keywords

不需要一開始做非常複雜的 SQL Parser。

---

# 11. Query Result

執行：

```sql
SELECT *
FROM users;
```

顯示：

```text
Result

┌────┬────────┬────────────────────┐
│ id │ name   │ email              │
├────┼────────┼────────────────────┤
│ 1  │ Kevin  │ kevin@example.com  │
│ 2  │ Alice  │ alice@example.com  │
└────┴────────┴────────────────────┘

2 rows
12ms
```

使用：

```text
TanStack Table
```

搭配 Virtualization。

---

# 12. Data Table

Double Click Table：

```text
users
```

開啟：

```text
Data | Structure
```

Phase 1 只需要兩個 Tab。

---

# 13. Data View

功能：

- Pagination
- Sort
- Filter
- Refresh
- Column Resize
- Column Visibility

預設例如：

```text
500 rows / page
```

禁止直接將整張大型 Table Load 到前端。

---

# 14. Data Editing

Phase 1 支援：

- Insert Row
- Update Row
- Delete Row

Cell 可以直接編輯。

修改後顯示 Dirty State。

例如：

```text
Alice*
```

底部：

```text
Save Changes

Revert
```

---

# 15. Basic Filter

第一階段 Filter 不需要複雜 Query Builder。

可以使用簡單：

```text
Column
Operator
Value
```

例如：

```text
status = active
```

支援：

```text
=
!=
>
<
>=
<=
LIKE
IS NULL
IS NOT NULL
```

---

# 16. Table Structure

Structure 顯示：

```text
Column
Type
Nullable
Default
Primary Key
```

例如：

```text
id          bigint       NO      PK
name        varchar      NO
email       varchar      YES
created_at  timestamp    NO
```

第一階段可以：

- 查看 Column
- 查看 Primary Key
- 查看 Default Value

暫時不用提供完整 Table Designer。

---

# 17. Redis Workspace

Redis 不需要強制套入 SQL Database UI。

Redis Connection 使用自己的 Workspace。

例如：

```text
Redis

DB0
  user:1
  user:2
  session:abc
```

支援：

- SCAN
- Search Key
- View Key
- Edit Key
- Delete Key
- TTL

---

# 18. Redis Data Types

Phase 1 支援：

```text
String
Hash
List
Set
Sorted Set
```

例如 Hash：

```text
user:1

name    Kevin
email   kevin@example.com
age     30
```

---

# 19. Query History

保存：

```text
SQL
Connection
Database
Executed At
Duration
Success / Error
```

支援：

- Search
- Copy
- Re-run

---

# 20. Application Settings

第一階段提供：

```text
General

Editor

Database

Agent / MCP

Security
```

General：

- Light / Dark / System
- Language
- Default Page Size

Editor：

- Font Size
- Tab Size
- Word Wrap

Database：

- Query Timeout
- Max Rows

---
