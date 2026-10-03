package com.sybase.jdbc4.jdbc;

import java.io.*;
import java.lang.reflect.*;
import java.math.BigDecimal;
import java.net.Socket;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;

/** Own JDBC contract double, NOT a SAP driver or TDS emulator. */
public class SybDriver implements Driver {
  static { try { DriverManager.registerDriver(new SybDriver()); } catch (SQLException e) { throw new RuntimeException(e); } }
  public boolean acceptsURL(String url) { return url.startsWith("jdbc:sybase:Tds:127.0.0.1:"); }
  public int getMajorVersion() { return 1; } public int getMinorVersion() { return 0; }
  public boolean jdbcCompliant() { return false; }
  public DriverPropertyInfo[] getPropertyInfo(String u, Properties p) { return new DriverPropertyInfo[0]; }
  public Logger getParentLogger() { return Logger.getGlobal(); }
  @SuppressWarnings("unchecked") static <T> T proxy(Class<T> type, InvocationHandler handler) {
    return (T) Proxy.newProxyInstance(SybDriver.class.getClassLoader(), new Class<?>[]{type}, handler);
  }
  static class State { String charset, password; int updates, rowcount, error; Socket socket; }
  public Connection connect(String url, Properties properties) throws SQLException {
    if (!acceptsURL(url)) return null;
    if (!"com.sybase.jdbc4.charset.PureConverter".equals(properties.getProperty("CHARSET_CONVERTER_CLASS")) ||
        !"true".equals(properties.getProperty("DISABLE_UNICHAR_SENDING")) ||
        !"false".equals(properties.getProperty("REQUEST_HA_SESSION")) ||
        !"false".equals(properties.getProperty("CONNECTION_FAILOVER"))) throw new SQLException("Unsafe connection properties");
    if (properties.getProperty("user").equals("loginhang")) {
      try { Thread.sleep(60000); } catch (InterruptedException e) { throw new SQLException(e); }
    }
    State state = new State(); state.charset = properties.getProperty("CHARSET"); state.password = properties.getProperty("password");
    if (properties.getProperty("user").equals("network")) {
      try {
        state.socket = new Socket("127.0.0.1", Integer.parseInt(url.substring(url.lastIndexOf(':') + 1)));
        state.socket.getOutputStream().write(1);
        if (state.socket.getInputStream().read() != 1) throw new IOException("Test login failed");
      } catch (IOException e) { throw new SQLException(e); }
    }
    return proxy(Connection.class, (p, m, a) -> {
      switch (m.getName()) {
        case "setCatalog": if (!a[0].equals("workspace")) throw new SQLException("Wrong database"); return null;
        case "getWarnings": return null;
        case "clearWarnings": return null;
        case "close": if (state.socket != null) state.socket.close(); return null;
        case "createStatement": return statement(state, null);
        case "prepareStatement": return statement(state, (String)a[0]);
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
  static PreparedStatement statement(State state, String prepared) {
    class Status { ResultSet result; String sql; int update = -1, maxRows; Map<Integer,Object> params = new HashMap<>(); }
    Status status = new Status();
    return proxy(PreparedStatement.class, (p, m, a) -> {
      switch (m.getName()) {
        case "setQueryTimeout": if ((int)a[0] < 1) throw new SQLException("No timeout"); return null;
        case "setMaxRows": status.maxRows = (int)a[0]; state.rowcount = 0; state.error = 0; return null;
        case "setNull": status.params.put((int)a[0], null); return null;
        case "setString": case "setBytes": case "setBoolean": case "setBigDecimal": case "setTimestamp": status.params.put((int)a[0], a[1]); return null;
        case "getWarnings": return null;
        case "clearWarnings": case "close": return null;
        case "executeQuery":
          if (!a[0].equals("SELECT @@client_csname")) throw new SQLException("Unexpected internal query");
          state.rowcount = 1; state.error = 0;
          return result(new Object[][]{{state.charset}}, new int[]{Types.VARCHAR}, new String[]{"charset"}, "SELECT charset");
        case "execute": {
          String sql = prepared == null ? (String)a[0] : prepared; status.sql = sql; status.update = -1;
          if (sql.equals("UPDATE two")) { state.rowcount = 2; state.error = 0; status.update = 2; return false; }
          if (sql.equals("UPDATE fail")) { state.rowcount = 0; state.error = 777; throw new SQLException("fixture error 777"); }
          if (sql.startsWith("IF @@rowcount <> 2")) {
            if (state.rowcount != 2) throw new SQLException("@@rowcount was changed between batches: " + state.rowcount);
            state.error = 0; return false;
          }
          if (sql.startsWith("IF @@error <> 777")) {
            if (state.error != 777) throw new SQLException("@@error was changed between batches: " + state.error);
            state.error = 0; return false;
          }
          if (sql.startsWith("SET CHAR_CONVERT ") && !sql.equals("SET CHAR_CONVERT " + state.charset + " WITH ERROR")) throw new SQLException("Wrong charset initialization");
          if (sql.startsWith("SET ") || sql.equals("BEGIN TRANSACTION") || sql.equals("COMMIT TRANSACTION") || sql.equals("ROLLBACK TRANSACTION")) return false;
          if (sql.equals("SELECT error")) throw new SQLException("failure with password " + state.password);
          if (sql.equals("SELECT switch_charset")) state.charset = state.charset.equals("big5") ? "utf8" : "big5";
          if (sql.equals("SELECT hang")) Thread.sleep(60000);
          if (sql.equals("SELECT network_wait")) {
            state.socket.getOutputStream().write(2);
            if (state.socket.getInputStream().read() != 2) throw new IOException("Test network closed");
          }
          if (sql.equals("UPDATE sample")) { state.updates++; status.update = 1; return false; }
          Object[][] rows; int[] types; String[] names;
          if (sql.contains("@@version")) { rows = new Object[][]{{"Adaptive Server Enterprise/16.0 SP04"}}; types = new int[]{Types.VARCHAR}; names = new String[]{"version"}; }
          else if (sql.equals("SELECT state")) { rows = new Object[][]{{state.updates}}; types = new int[]{Types.INTEGER}; names = new String[]{"value"}; }
          else if (sql.equals("SELECT charset")) { rows = new Object[][]{{state.charset}}; types = new int[]{Types.VARCHAR}; names = new String[]{"value"}; }
          else if (sql.equals("SELECT exact")) {
            rows = new Object[][]{{new BigDecimal("12345678901234567890.123456789012345678"), new BigDecimal("9223372036854775807"), "中文😀\0'\n", "", null, new byte[0], new byte[]{0, (byte)255}, "2026-09-30 23:59:59.123456", true, 1.25}};
            types = new int[]{Types.DECIMAL,Types.BIGINT,Types.NVARCHAR,Types.VARCHAR,Types.VARCHAR,Types.VARBINARY,Types.VARBINARY,Types.TIMESTAMP,Types.BIT,Types.DOUBLE};
            names = new String[]{"decimal","bigint","中文","empty","nullable","empty_binary","binary","timestamp","bit","float"};
          } else if (sql.equals("SELECT params")) {
            Object[] values = new Object[status.params.size()]; types = new int[values.length]; names = new String[values.length];
            for (int i = 0; i < values.length; i++) { Object v = status.params.get(i+1); values[i] = v; types[i] = v == null ? Types.VARCHAR : v instanceof byte[] ? Types.VARBINARY : v instanceof Boolean ? Types.BIT : v instanceof BigDecimal ? Types.DECIMAL : v instanceof Timestamp ? Types.TIMESTAMP : Types.VARCHAR; names[i] = "p"+(i+1); }
            rows = new Object[][]{values};
          } else if (sql.equals("SELECT huge")) { rows = new Object[][]{{"huge"}}; types = new int[]{Types.VARCHAR}; names = new String[]{"value"}; }
          else if (sql.equals("SELECT unsupported")) { rows = new Object[][]{{"unsupported"}}; types = new int[]{Types.JAVA_OBJECT}; names = new String[]{"value"}; }
          else if (sql.equals("SELECT many") || sql.equals("SELECT warning")) {
            int count = status.maxRows > 0 ? Math.min(status.maxRows, 20) : 20;
            rows = new Object[count][1]; for (int i = 0; i < count; i++) rows[i][0] = i+1;
            types = new int[]{Types.INTEGER}; names = new String[]{"value"};
          } else { rows = new Object[][]{{1}}; types = new int[]{Types.INTEGER}; names = new String[]{"value"}; }
          status.result = result(rows, types, names, sql); return true;
        }
        case "getResultSet": return status.result;
        case "getUpdateCount": return status.update;
        case "getMoreResults": status.update = -1; return false;
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
  static ResultSet result(Object[][] rows, int[] types, String[] names, String sql) {
    class Cursor { int row = -1; boolean wasNull; } Cursor c = new Cursor();
    return proxy(ResultSet.class, (p, m, a) -> {
      switch (m.getName()) {
        case "next": return ++c.row < rows.length;
        case "close": return null;
        case "getWarnings": return sql.equals("SELECT warning") && c.row >= rows.length ? new SQLWarning("data truncated", "01004") : null;
        case "wasNull": return c.wasNull;
        case "getMetaData": return proxy(ResultSetMetaData.class, (mp, mm, ma) -> {
          switch (mm.getName()) {
            case "getColumnCount": return names.length;
            case "getColumnLabel": return names[(int)ma[0]-1];
            case "getColumnType": return types[(int)ma[0]-1];
            default: throw new UnsupportedOperationException(mm.getName());
          }
        });
      }
      Object value = rows[c.row][(int)a[0]-1]; c.wasNull = value == null;
      switch (m.getName()) {
        case "getBigDecimal": return value;
        case "getInt": return value == null ? 0 : ((Number)value).intValue();
        case "getDouble": return value == null ? 0.0 : ((Number)value).doubleValue();
        case "getBoolean": return value == null ? false : value;
        case "getString": return value == null ? null : value.toString();
        case "getBinaryStream": return value == null ? null : new ByteArrayInputStream((byte[])value);
        case "getCharacterStream": {
          if (sql.equals("SELECT huge")) return new Reader() {
            int remaining = 8 * 1024 * 1024 + 1;
            public int read(char[] target, int offset, int length) { if (remaining == 0) return -1; int n = Math.min(length, remaining); Arrays.fill(target, offset, offset+n, 'x'); remaining -= n; return n; }
            public void close() {}
          };
          return value == null ? null : new StringReader((String)value);
        }
        default: throw new UnsupportedOperationException(m.getName());
      }
    });
  }
}
