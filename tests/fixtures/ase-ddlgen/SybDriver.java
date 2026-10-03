package com.sybase.jdbc4.jdbc;

import java.io.*;
import java.lang.reflect.*;
import java.math.BigDecimal;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;

/** Own test double, NOT SAP code. Validates the worker's JDBC call contract. */
public class SybDriver implements Driver {
  static { try { DriverManager.registerDriver(new SybDriver()); } catch (SQLException e) { throw new RuntimeException(e); } }
  public boolean acceptsURL(String url) { return url.startsWith("jdbc:sybase:Tds:127.0.0.1:"); }
  public int getMajorVersion() { return 1; }
  public int getMinorVersion() { return 0; }
  public boolean jdbcCompliant() { return false; }
  public DriverPropertyInfo[] getPropertyInfo(String u, Properties p) { return new DriverPropertyInfo[0]; }
  public Logger getParentLogger() { return Logger.getGlobal(); }
  @SuppressWarnings("unchecked") static <T> T proxy(Class<T> type, InvocationHandler handler) {
    return (T) Proxy.newProxyInstance(SybDriver.class.getClassLoader(), new Class<?>[]{type}, handler);
  }
  static final String[] NAMES = {"id", "amount", "note", "payload", "ratio", "moment", "clock", "day", "flag", "optional", "stamp", "computed"};
  static final String[] DECLARED = {"bigint", "decimal", "univarchar", "image", "float", "bigdatetime", "bigtime", "date", "bit", "varchar", "timestamp", "int"};
  static class State {
    String mode; int catalog; boolean begun, rollback;
    State(String mode) { this.mode = mode; }
  }
  public Connection connect(String url, Properties properties) throws SQLException {
    if (!acceptsURL(url)) return null;
    if (!"utf8".equals(properties.getProperty("CHARSET"))) throw new SQLException("Expected UTF-8");
    State state = new State(properties.getProperty("user"));
    return proxy(Connection.class, (p, m, a) -> {
      switch (m.getName()) {
        case "createStatement": return statement(state);
        case "close": if (state.begun && !state.rollback) throw new SQLException("Read transaction not rolled back"); return null;
        case "isClosed": return false;
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
  static Statement statement(State state) {
    class Status { ResultSet result; boolean data; }
    Status status = new Status();
    return proxy(Statement.class, (p, m, a) -> {
      switch (m.getName()) {
        case "setQueryTimeout": if ((int)a[0] < 1) throw new SQLException("Missing deadline"); return null;
        case "execute": {
          String sql = (String)a[0];
          if (sql.startsWith("LOCK TABLE ")) {
            if (!state.begun || !sql.contains("SELECT @@error")) throw new SQLException("Lock must be checked inside transaction");
            if (state.mode.equals("missinglock")) return false;
            status.result = result(new Object[][]{{state.mode.equals("lockfail") ? 12207 : 0}}, new int[]{Types.INTEGER});
            return true;
          }
          if (sql.equals("BEGIN TRANSACTION")) state.begun = true;
          else if (sql.equals("ROLLBACK TRANSACTION")) state.rollback = true;
          else if (!sql.startsWith("USE ") && !sql.startsWith("SET ")) throw new SQLException("Unexpected source write: " + sql);
          return false;
        }
        case "executeQuery": {
          String sql = (String)a[0];
          Object[][] rows;
          if (sql.equals("SELECT @@version")) rows = new Object[][]{{"Adaptive Server Enterprise/16.0 SP04"}};
          else if (sql.startsWith("SELECT COUNT(*)")) rows = new Object[][]{{state.mode.equals("predicated") ? "1" : "0"}};
          else if (sql.contains("identity_burn_max")) rows = new Object[][]{{"9223372036854775807"}};
          else if (sql.startsWith("SELECT o.id")) {
            state.catalog++;
            rows = new Object[][]{{state.mode.equals("tablechanged") && state.catalog > 2 ? 2 : 1, "dbo", "資料表", state.mode.equals("remote") ? 1024 : 0}};
          } else if (sql.startsWith("SELECT c.name")) {
            rows = new Object[NAMES.length][5];
            for (int i = 0; i < NAMES.length; i++) rows[i] = new Object[]{NAMES[i], DECLARED[i], i == 0 ? 128 : 0, i == 11 ? 1 : 0, state.mode.equals("encrypted") ? 1 : 0};
          } else if (sql.startsWith("SELECT ") && sql.contains(" FROM [dbo].[資料表]")) {
            if (!state.begun || state.rollback || !sql.contains(",140)") || sql.contains("[stamp]") || sql.contains("[computed]")) throw new SQLException("Unsafe data projection");
            status.data = true;
            rows = new Object[][]{{new BigDecimal("9223372036854775806"), new BigDecimal("12345678901234567890.123456789012345678"), "中文😀'\\\nGO\n\0", new byte[]{0, 1, (byte)255}, Double.MIN_VALUE, "2026-09-30 23:59:59.123456", "23:59:59.654321", "0001-01-01", true, null,
              8, 17, state.mode.equals("oversizedvalue") ? 17000000 : 20, 3, 8, 8, 8, 4, 1, null}};
            return result(rows, new int[]{Types.BIGINT, Types.DECIMAL, Types.NVARCHAR, Types.LONGVARBINARY, Types.DOUBLE, Types.VARCHAR, Types.VARCHAR, Types.VARCHAR, Types.BIT, Types.VARCHAR});
          } else throw new SQLException("Unexpected query: " + sql);
          return result(rows, new int[]{Types.VARCHAR});
        }
        case "getResultSet": return status.result;
        case "getUpdateCount": return -1;
        case "getMoreResults": return false;
        case "getWarnings": return status.data && state.mode.equals("warning") ? new SQLWarning("data truncated") : null;
        case "close": return null;
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
  static ResultSet result(Object[][] rows, int[] types) {
    class Cursor { int row = -1; boolean wasNull; }
    Cursor cursor = new Cursor();
    return proxy(ResultSet.class, (p, m, a) -> {
      switch (m.getName()) {
        case "next": return ++cursor.row < rows.length;
        case "close": return null;
        case "getWarnings": return null;
        case "wasNull": return cursor.wasNull;
        case "getMetaData": return proxy(ResultSetMetaData.class, (mp, mm, ma) -> {
          if (mm.getName().equals("getColumnType")) return types[(int)ma[0] - 1];
          if (mm.getName().equals("getColumnTypeName")) return "fixture_type";
          throw new UnsupportedOperationException(mm.getName());
        });
      }
      Object value = rows[cursor.row][(int)a[0] - 1]; cursor.wasNull = value == null;
      switch (m.getName()) {
        case "getString": return value == null ? null : value.toString();
        case "getInt": return value == null ? 0 : ((Number)value).intValue();
        case "getLong": return value == null ? 0L : ((Number)value).longValue();
        case "getBigDecimal": return value;
        case "getDouble": return value == null ? 0.0 : ((Number)value).doubleValue();
        case "getBoolean": return value == null ? false : value;
        case "getBinaryStream": return value == null ? null : new ByteArrayInputStream((byte[])value);
        case "getCharacterStream": return value == null ? null : new StringReader((String)value);
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
}
