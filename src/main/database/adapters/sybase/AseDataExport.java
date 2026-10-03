import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/** App-owned JDBC worker. Launched in Java source-file mode (JDK 11+).
 * No SAP classes are linked at compile time; only the selected jconn4.jar is loaded.
 * stdin: base64 URL, user, password, database, then integer timeout seconds.
 * stdout: READY, SQL:<base64>, PROGRESS:<tables>:<rows>:<base64 table>, DONE.
 * Each SQL record waits for ACK. READY waits for DATA; data completion waits
 * for COMMIT before releasing the shared locks, so schema checks can finish.
 */
class AseDataExport {
  static final int LIMIT = 16 * 1024 * 1024;
  static final BufferedReader INPUT = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
  static final PrintWriter OUTPUT = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
  static int timeout;
  static long bytes, rows;
  static class Column {
    final String name, declared;
    final boolean identity;
    Column(String name, String declared, boolean identity) { this.name = name; this.declared = declared; this.identity = identity; }
  }
  static class Table {
    final int id;
    final String name;
    final List<Column> columns = new ArrayList<>();
    Table(int id, String name) { this.id = id; this.name = name; }
  }
  static String read() throws IOException {
    String line = INPUT.readLine();
    if (line == null) throw new EOFException("Export controller disconnected.");
    return line;
  }
  static String decode() throws IOException { return new String(Base64.getDecoder().decode(read()), StandardCharsets.UTF_8); }
  static String base64(String text) { return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)); }
  static String quote(String name) { return "[" + name.replace("]", "]]") + "]"; }
  static String literal(String text) { return "'" + text.replace("'", "''") + "'"; }
  static void expect(String command) throws IOException { if (!command.equals(read())) throw new IOException("Invalid export acknowledgement."); }
  static void emit(String sql) throws Exception {
    byte[] encoded = sql.getBytes(StandardCharsets.UTF_8);
    if ((bytes += encoded.length) > LIMIT) throw new IOException("ASE SQL data exceeds the 16 MiB export limit.");
    OUTPUT.println("SQL:" + Base64.getEncoder().encodeToString(encoded));
    if (OUTPUT.checkError()) throw new IOException("Export controller disconnected.");
    expect("ACK");
  }
  static Statement statement(Connection connection) throws SQLException {
    Statement statement = connection.createStatement();
    statement.setQueryTimeout(timeout);
    return statement;
  }
  static void warnings(Statement statement, ResultSet result) throws SQLException {
    if (statement.getWarnings() != null) throw new SQLException("ASE returned a warning: " + statement.getWarnings().getMessage());
    if (result != null && result.getWarnings() != null) throw new SQLException("ASE returned a data warning: " + result.getWarnings().getMessage());
  }
  static void execute(Connection connection, String sql) throws SQLException {
    try (Statement statement = statement(connection)) {
      boolean result = statement.execute(sql);
      while (result || statement.getUpdateCount() != -1) {
        if (result) try (ResultSet rs = statement.getResultSet()) { while (rs.next()) {} }
        result = statement.getMoreResults();
      }
      warnings(statement, null);
    }
  }
  static String scalar(Connection connection, String sql) throws SQLException {
    try (Statement statement = statement(connection); ResultSet rs = statement.executeQuery(sql)) {
      if (!rs.next()) throw new SQLException("ASE metadata is incomplete.");
      String value = rs.getString(1);
      if (rs.next()) throw new SQLException("Unexpected ASE metadata rows.");
      warnings(statement, rs);
      return value;
    }
  }
  static List<Table> tables(Connection connection) throws SQLException {
    List<Table> tables = new ArrayList<>();
    try (Statement statement = statement(connection); ResultSet rs = statement.executeQuery(
        "SELECT o.id,u.name,o.name,o.sysstat2 FROM dbo.sysobjects o JOIN dbo.sysusers u ON o.uid=u.uid WHERE o.type='U' ORDER BY o.id")) {
      while (rs.next()) {
        if (tables.size() >= 5000) throw new SQLException("ASE metadata exceeds the table limit.");
        if ((rs.getLong(4) & 3072) != 0) throw new SQLException("ASE data export does not support remote or proxy tables.");
        tables.add(new Table(rs.getInt(1), quote(rs.getString(2)) + "." + quote(rs.getString(3))));
      }
      warnings(statement, rs);
    }
    return tables;
  }
  static String signature(List<Table> tables) {
    StringBuilder text = new StringBuilder();
    for (Table table : tables) text.append(table.id).append(':').append(base64(table.name)).append(';');
    return text.toString();
  }
  static void lock(Connection connection, Table table) throws SQLException {
    // ASE lock timeout may be informational, so SELECT @@error is mandatory.
    try (Statement statement = statement(connection)) {
      boolean result = statement.execute("LOCK TABLE " + table.name + " IN SHARE MODE WAIT " + timeout + "; SELECT @@error AS lock_error");
      boolean confirmed = false;
      while (result || statement.getUpdateCount() != -1) {
        if (result) try (ResultSet rs = statement.getResultSet()) {
          while (rs.next()) { if (rs.getInt(1) != 0 || rs.wasNull()) throw new SQLException("ASE could not obtain the shared table lock."); confirmed = true; }
        }
        result = statement.getMoreResults();
      }
      warnings(statement, null);
      if (!confirmed) throw new SQLException("ASE did not confirm the shared table lock.");
    }
  }
  static void columns(Connection connection, Table table) throws SQLException {
    try (Statement statement = statement(connection); ResultSet rs = statement.executeQuery(
        "SELECT c.name,COALESCE(b.name,t.name),c.status,c.computedcol,c.encrkeyid FROM dbo.syscolumns c JOIN dbo.systypes t ON t.usertype=c.usertype LEFT JOIN dbo.systypes b ON b.type=t.type AND b.name IN ('date','time','bigtime','datetime','bigdatetime','smalldatetime') AND b.usertype<100 WHERE c.id=" + table.id + " ORDER BY c.colid")) {
      while (rs.next()) {
        if (rs.getInt(5) != 0) throw new SQLException("ASE encrypted-column data requires a dedicated backup workflow.");
        if (rs.getInt(4) != 0 || "timestamp".equalsIgnoreCase(rs.getString(2))) continue;
        table.columns.add(new Column(rs.getString(1), rs.getString(2).toLowerCase(Locale.ROOT), (rs.getInt(3) & 128) != 0));
      }
      warnings(statement, rs);
    }
    if (table.columns.isEmpty()) throw new SQLException("ASE data export needs at least one stored non-timestamp column: " + table.name);
  }
  static String unicode(Reader reader) throws Exception {
    if (reader == null) return "NULL";
    StringBuilder sql = new StringBuilder("U&'");
    try (Reader input = reader) {
      int value;
      while ((value = input.read()) != -1) {
        int code = value;
        if (Character.isHighSurrogate((char) value)) {
          int low = input.read();
          if (low == -1 || !Character.isLowSurrogate((char) low)) throw new IOException("Invalid UTF-16 from ASE JDBC.");
          code = Character.toCodePoint((char) value, (char) low);
        } else if (Character.isLowSurrogate((char) value)) throw new IOException("Invalid UTF-16 from ASE JDBC.");
        // Escaping every scalar preserves quotes, backslashes, NUL and newlines,
        // including literal lines named GO, without relying on client encoding.
        String hex = Integer.toHexString(code);
        sql.append(code > 65535 ? "\\+" : "\\");
        for (int pad = hex.length(); pad < (code > 65535 ? 6 : 4); pad++) sql.append('0');
        sql.append(hex);
        if (sql.length() > LIMIT) throw new IOException("ASE text exceeds the SQL export limit.");
      }
    }
    return sql.append('\'').toString();
  }
  static String binary(InputStream stream) throws Exception {
    if (stream == null) return "NULL";
    StringBuilder sql = new StringBuilder("0x");
    char[] digits = "0123456789abcdef".toCharArray();
    try (InputStream input = stream) {
      byte[] buffer = new byte[8192];
      int size;
      while ((size = input.read(buffer)) != -1) {
        if (sql.length() + size * 2 > LIMIT) throw new IOException("ASE binary data exceeds the SQL export limit.");
        for (int index = 0; index < size; index++) { int value = buffer[index] & 255; sql.append(digits[value >> 4]).append(digits[value & 15]); }
      }
    }
    return sql.toString();
  }
  static String temporal(String value, String type) throws SQLException {
    if (value == null) return "NULL";
    String shape = type.equals("date") ? "\\d{4}-\\d{2}-\\d{2}" :
      (type.equals("time") || type.equals("bigtime")) ? "\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?" :
      "\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?";
    if (!value.matches(shape)) throw new SQLException("ASE JDBC returned an unsupported temporal representation.");
    // Emit yyyymmdd to make the date independent of language/dateformat.
    String normalized = value.replace('T', ' ');
    if (!type.equals("time") && !type.equals("bigtime")) normalized = normalized.substring(0, 10).replace("-", "") + normalized.substring(10);
    return "CONVERT(" + type + "," + literal(normalized) + ")";
  }
  static boolean temporalType(String type) {
    return Arrays.asList("date", "time", "bigtime", "datetime", "bigdatetime", "smalldatetime").contains(type);
  }
  static String projection(Column column) {
    String name = quote(column.name);
    // The server formats temporal values before JDBC can round time fractions.
    // Style 140 preserves all six ASE fractional digits and uses numeric dates.
    if (temporalType(column.declared)) {
      String formatted = "CONVERT(varchar(64),CONVERT(bigdatetime," + name + "),140)";
      if (column.declared.equals("date")) return "SUBSTRING(" + formatted + ",1,10)";
      if (column.declared.equals("time") || column.declared.equals("bigtime")) return "SUBSTRING(" + formatted + ",12,15)";
      return formatted;
    }
    return name;
  }
  static String value(ResultSet rs, int index, Column column) throws Exception {
    ResultSetMetaData meta = rs.getMetaData();
    int type = meta.getColumnType(index);
    if (temporalType(column.declared))
      return temporal(rs.getString(index), column.declared);
    switch (type) {
      case Types.TINYINT: case Types.SMALLINT: case Types.INTEGER: case Types.BIGINT:
      case Types.NUMERIC: case Types.DECIMAL:
        BigDecimal decimal = rs.getBigDecimal(index);
        if (decimal == null) return "NULL";
        return decimal.toPlainString();
      case Types.BIT: case Types.BOOLEAN:
        boolean flag = rs.getBoolean(index); return rs.wasNull() ? "NULL" : flag ? "1" : "0";
      case Types.REAL:
        float single = rs.getFloat(index); if (rs.wasNull()) return "NULL";
        if (!Float.isFinite(single)) throw new SQLException("ASE SQL export cannot restore a non-finite float.");
        return "CONVERT(real," + literal(Float.toString(single)) + ")";
      case Types.FLOAT: case Types.DOUBLE:
        double number = rs.getDouble(index); if (rs.wasNull()) return "NULL";
        if (!Double.isFinite(number)) throw new SQLException("ASE SQL export cannot restore a non-finite float.");
        return "CONVERT(float," + literal(Double.toString(number)) + ")";
      case Types.BINARY: case Types.VARBINARY: case Types.LONGVARBINARY: case Types.BLOB:
        return binary(rs.getBinaryStream(index));
      case Types.CHAR: case Types.VARCHAR: case Types.LONGVARCHAR: case Types.CLOB:
      case Types.NCHAR: case Types.NVARCHAR: case Types.LONGNVARCHAR: case Types.NCLOB:
        return unicode(rs.getCharacterStream(index));
      case Types.DATE: case Types.TIME: case Types.TIMESTAMP:
        throw new SQLException("ASE temporal base type could not be resolved without losing precision.");
      default: throw new SQLException("Unsupported ASE JDBC data type: " + meta.getColumnTypeName(index));
    }
  }
  static void data(Connection connection, Table table, int total) throws Exception {
    boolean identity = table.columns.stream().anyMatch(column -> column.identity);
    String names = String.join(",", table.columns.stream().map(column -> quote(column.name)).toArray(String[]::new));
    if (identity) emit("SET IDENTITY_INSERT " + table.name + " ON\nGO\n");
    String lengths = String.join(",", table.columns.stream().map(column -> "DATALENGTH(" + quote(column.name) + ")").toArray(String[]::new));
    String values = String.join(",", table.columns.stream().map(AseDataExport::projection).toArray(String[]::new));
    try (Statement statement = statement(connection); ResultSet rs = statement.executeQuery("SELECT " + values + "," + lengths + " FROM " + table.name)) {
      while (rs.next()) {
        StringBuilder sql = new StringBuilder("INSERT INTO " + table.name + " (" + names + ") VALUES (");
        for (int index = 0; index < table.columns.size(); index++) {
          if (rs.getLong(table.columns.size() + index + 1) > LIMIT) throw new IOException("ASE value exceeds TEXTSIZE/export limit; truncated data cannot be exported.");
          if (index != 0) sql.append(',');
          sql.append(value(rs, index + 1, table.columns.get(index)));
          if (sql.length() > LIMIT) throw new IOException("ASE row exceeds the SQL export limit.");
        }
        warnings(statement, rs);
        emit(sql.append(")\nGO\n").toString()); rows++;
        OUTPUT.println("PROGRESS:" + total + ":" + rows + ":" + base64(table.name));
      }
      warnings(statement, rs);
    }
    if (identity) {
      emit("SET IDENTITY_INSERT " + table.name + " OFF\nGO\n");
      String maximum = scalar(connection, "SELECT CONVERT(varchar(100),identity_burn_max(" + literal(table.name) + "))");
      if (maximum == null || !maximum.matches("[0-9]+")) throw new SQLException("ASE identity high-water mark is unavailable.");
      emit("EXEC sp_chgattribute " + literal(table.name) + ",'identity_burn_max',0," + literal(maximum) + "\nGO\n");
    }
  }
  static void run() throws Exception {
    String url = decode(), username = decode(), password = decode(), database = decode();
    timeout = Integer.parseInt(read());
    if (!url.matches("jdbc:sybase:Tds:127\\.0\\.0\\.1:[0-9]+") || timeout < 1 || timeout > 300) throw new IOException("Invalid export transport configuration.");
    Class.forName("com.sybase.jdbc4.jdbc.SybDriver");
    Properties properties = new Properties(); properties.setProperty("user", username); properties.setProperty("password", password);
    properties.setProperty("CHARSET", "utf8"); properties.setProperty("REQUEST_HA_SESSION", "false");
    DriverManager.setLoginTimeout(timeout);
    try (Connection connection = DriverManager.getConnection(url, properties)) {
      if (!scalar(connection, "SELECT @@version").matches("(?s).*Adaptive Server Enterprise/16\\..*")) throw new SQLException("Data export requires SAP ASE 16.x.");
      execute(connection, "USE " + quote(database));
      execute(connection, "SET QUOTED_IDENTIFIER ON");
      execute(connection, "SET TEXTSIZE " + LIMIT);
      execute(connection, "SET CHAR_CONVERT 'utf8' WITH ERROR");
      if (!"0".equals(scalar(connection, "SELECT COUNT(*) FROM dbo.sysprotects WHERE predid<>0")) ||
          !"0".equals(scalar(connection, "SELECT COUNT(*) FROM dbo.sysobjects WHERE type='R' AND (sysstat2 & 83886080)<>0")))
        throw new SQLException("ASE predicated privileges or access rules prevent a complete data export.");
      List<Table> tables = tables(connection);
      execute(connection, "BEGIN TRANSACTION");
      try {
        for (Table table : tables) { lock(connection, table); columns(connection, table); }
        if (!signature(tables).equals(signature(tables(connection)))) throw new SQLException("ASE table list changed while locking.");
        for (Table table : tables) OUTPUT.println("TABLE:" + base64(table.name));
        OUTPUT.println("READY:" + tables.size()); expect("DATA");
        emit("USE " + quote(database) + "\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nSET STRING_RTRUNCATION ON\nGO\n");
        for (Table table : tables) data(connection, table, tables.size());
        if (!signature(tables).equals(signature(tables(connection)))) throw new SQLException("ASE table list changed during export.");
        OUTPUT.println("DATA_DONE"); expect("COMMIT");
      } finally {
        // This transaction is read-only; rollback releases every shared lock.
        execute(connection, "ROLLBACK TRANSACTION");
      }
    }
    OUTPUT.println("DONE");
  }
  public static void main(String[] args) {
    try { run(); }
    catch (Throwable error) { OUTPUT.println("ERROR:" + base64(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())); System.exit(1); }
  }
}
