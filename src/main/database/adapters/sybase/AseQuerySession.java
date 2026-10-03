import java.io.*;
import java.math.BigDecimal;
import java.nio.*;
import java.nio.charset.*;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** JDK 11+ source-mode worker. No SAP classes are required at compile time.
 * stdin/stdout carry bounded, length-prefixed ASCII frames; text is UTF-8/base64.
 * One process owns one JDBC session. Killing it never replays a statement. */
class AseQuerySession {
  static final int MAX_FRAME = 16 * 1024 * 1024, MAX_VALUE = 8 * 1024 * 1024;
  static final DataInputStream IN = new DataInputStream(new BufferedInputStream(System.in));
  static final DataOutputStream OUT = new DataOutputStream(new BufferedOutputStream(System.out));
  static final Map<String, String> CHARSETS = Map.of(
    "utf8", "UTF-8", "iso_1", "ISO-8859-1", "cp1252", "windows-1252", "big5", "Big5",
    "cp936", "GBK", "gb18030", "GB18030", "sjis", "MS932", "eucjis", "EUC-JP");
  static Charset charset;
  static String charsetName;
  static class SessionEncodingException extends SQLException {
    SessionEncodingException() { super("ASE session character set differs from the connection setting; reconnect before further queries. The query may already have executed"); }
  }

  static String[] read() throws Exception {
    int length = IN.readInt();
    if (length < 1 || length > MAX_FRAME) throw new IOException("Invalid worker frame size");
    byte[] bytes = new byte[length]; IN.readFully(bytes);
    for (byte b : bytes) if (b < 0) throw new IOException("Invalid worker frame encoding");
    return new String(bytes, StandardCharsets.US_ASCII).split("\t", -1);
  }
  static void send(String message) throws Exception {
    if (message.length() > MAX_FRAME) throw new IOException("ASE result exceeds worker frame limit");
    byte[] bytes = message.getBytes(StandardCharsets.US_ASCII);
    OUT.writeInt(bytes.length); OUT.write(bytes); OUT.flush();
  }
  static byte[] utf8(String value) throws CharacterCodingException {
    ByteBuffer buffer = StandardCharsets.UTF_8.newEncoder()
      .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
      .encode(CharBuffer.wrap(value));
    byte[] bytes = new byte[buffer.remaining()]; buffer.get(bytes); return bytes;
  }
  static String b64(String value) throws Exception {
    byte[] bytes = utf8(value);
    if (bytes.length > MAX_VALUE) throw new IOException("ASE text exceeds the 8 MiB value limit");
    return Base64.getEncoder().encodeToString(bytes);
  }
  static String text(String value) throws Exception {
    byte[] bytes = Base64.getDecoder().decode(value);
    if (!Base64.getEncoder().encodeToString(bytes).equals(value)) throw new IOException("Invalid base64");
    return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
  }
  static void representable(String value) throws Exception {
    ByteBuffer encoded = charset.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value));
    if (!charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(encoded).toString().equals(value))
      throw new CharacterCodingException();
  }
  static void warning(SQLWarning warning) throws SQLException {
    if (warning != null) throw new SQLException("ASE JDBC warning; result was not accepted: " + warning.getMessage(), warning);
  }
  static void init(Connection connection, String name) throws Exception {
    try (Statement statement = connection.createStatement()) {
      statement.execute("SET CHAR_CONVERT " + name + " WITH ERROR");
      warning(statement.getWarnings());
      statement.clearWarnings();
      statement.execute("SET STRING_RTRUNCATION ON");
      warning(statement.getWarnings());
      statement.clearWarnings();
      // Server default TEXTSIZE is often much smaller than the application limit.
      statement.execute("SET TEXTSIZE 2147483647");
      warning(statement.getWarnings());
    }
    checkCharset(connection, DriverManager.getLoginTimeout());
  }
  static void checkCharset(Connection connection, int timeout) throws Exception {
    try (Statement statement = connection.createStatement()) {
      statement.setQueryTimeout(timeout);
      try (ResultSet result = statement.executeQuery("SELECT @@client_csname")) {
        if (!result.next() || !charsetName.equalsIgnoreCase(result.getString(1)))
          throw new SessionEncodingException();
        warning(result.getWarnings());
      }
      warning(statement.getWarnings());
    }
  }
  static String readText(Reader reader) throws Exception {
    if (reader == null) return "N";
    try (Reader source = reader) {
      StringBuilder value = new StringBuilder(); char[] buffer = new char[8192]; int n;
      while ((n = source.read(buffer)) != -1) {
        if (value.length() + n > MAX_VALUE) throw new IOException("ASE text exceeds the 8 MiB value limit");
        value.append(buffer, 0, n);
      }
      return "S" + b64(value.toString());
    }
  }
  static String readBinary(InputStream stream) throws Exception {
    if (stream == null) return "N";
    try (InputStream source = stream) {
      byte[] value = source.readNBytes(MAX_VALUE + 1);
      if (value.length > MAX_VALUE) throw new IOException("ASE binary exceeds the 8 MiB value limit");
      return "X" + Base64.getEncoder().encodeToString(value);
    }
  }
  static String type(int jdbc) throws SQLException {
    switch (jdbc) {
      case Types.NUMERIC: case Types.DECIMAL: return "numeric";
      case Types.BIGINT: return "bigint";
      case Types.TINYINT: case Types.SMALLINT: case Types.INTEGER: return "int";
      case Types.FLOAT: case Types.DOUBLE: case Types.REAL: return "float";
      case Types.BOOLEAN: case Types.BIT: return "bit";
      case Types.BINARY: case Types.VARBINARY: case Types.LONGVARBINARY: case Types.BLOB: return "binary";
      case Types.CHAR: case Types.VARCHAR: case Types.LONGVARCHAR: case Types.CLOB:
      case Types.NCHAR: case Types.NVARCHAR: case Types.LONGNVARCHAR: case Types.NCLOB: return "varchar";
      case Types.DATE: case Types.TIME: case Types.TIMESTAMP: return "datetime";
      case Types.NULL: return "null";
      default: throw new SQLException("Unsupported JDBC result type: " + jdbc);
    }
  }
  static String cell(ResultSet rows, int column, int jdbc) throws Exception {
    String kind = type(jdbc);
    switch (kind) {
      case "numeric": case "bigint": {
        BigDecimal number = rows.getBigDecimal(column);
        return number == null ? "N" : "S" + b64(number.toPlainString());
      }
      case "int": { int v = rows.getInt(column); return rows.wasNull() ? "N" : "D" + v; }
      case "float": {
        double v = rows.getDouble(column);
        if (rows.wasNull()) return "N";
        if (!Double.isFinite(v)) throw new SQLException("Non-finite ASE number");
        return "D" + Double.toString(v);
      }
      case "bit": { boolean v = rows.getBoolean(column); return rows.wasNull() ? "N" : v ? "B1" : "B0"; }
      case "binary": return readBinary(rows.getBinaryStream(column));
      case "varchar": return readText(rows.getCharacterStream(column));
      case "datetime": {
        // JDBC string conversion preserves fractional seconds without JS Date rounding.
        String value = rows.getString(column); return value == null ? "N" : "S" + b64(value);
      }
      case "null": return "N";
      default: throw new SQLException("Unsupported JDBC result value");
    }
  }
  static void bind(PreparedStatement statement, int index, String value) throws Exception {
    if (value.isEmpty()) throw new IOException("Invalid parameter");
    String content = value.substring(1);
    switch (value.charAt(0)) {
      case 'N': if (!content.isEmpty()) throw new IOException("Invalid NULL"); statement.setNull(index, Types.NULL); break;
      case 'S': statement.setString(index, text(content)); break;
      case 'X': statement.setBytes(index, Base64.getDecoder().decode(content)); break;
      case 'B': if (!content.equals("0") && !content.equals("1")) throw new IOException("Invalid boolean"); statement.setBoolean(index, content.equals("1")); break;
      case 'D': statement.setBigDecimal(index, new BigDecimal(content)); break;
      case 'T': statement.setTimestamp(index, Timestamp.from(Instant.parse(content)), Calendar.getInstance(TimeZone.getTimeZone("UTC"))); break;
      default: throw new IOException("Unsupported parameter type");
    }
  }
  static void execute(Connection connection, String[] request) throws Exception {
    if (request.length < 5 || !(request[0].equals("Q") || request[0].equals("S") || request[0].equals("V")))
      throw new IOException("Invalid query frame");
    int timeout = Integer.parseInt(request[1]), maxRows = Integer.parseInt(request[2]), count = Integer.parseInt(request[4]);
    if (timeout < 1 || timeout > 300 || maxRows < 0 || count < 0 || count > 5000 || request.length != count + 5)
      throw new IOException("Invalid query bounds");
    String sql = text(request[3]);
    if (request[0].equals("V")) {
      if (maxRows != 0 || count != 0 || !sql.isEmpty()) throw new IOException("Invalid verification frame");
      checkCharset(connection, timeout); return;
    }
    boolean preserveSession = request[0].equals("S");
    if (preserveSession && maxRows != 0) throw new IOException("Script batches cannot change JDBC maxRows");
    try {
      representable(sql);
      for (int i = 0; i < count; i++)
        if (request[i + 5].startsWith("S")) representable(text(request[i + 5].substring(1)));
    } catch (CharacterCodingException e) {
      throw new SQLException("SQL or parameter cannot be represented in the selected ASE character set; statement was not sent");
    }
    connection.clearWarnings();
    // A probe changes @@rowcount/@@error. Stateful batches must be contiguous;
    // their owning task verifies once at the end, before reporting success.
    if (!preserveSession) checkCharset(connection, timeout);
    try (Statement statement = count == 0 ? connection.createStatement() : connection.prepareStatement(sql)) {
      statement.setQueryTimeout(timeout);
      // Some drivers implement this using SET ROWCOUNT. Do not inject that
      // statement into a script session, even when the requested limit is zero.
      if (!preserveSession) statement.setMaxRows(maxRows);
      for (int i = 0; i < count; i++) bind((PreparedStatement) statement, i + 1, request[i + 5]);
      boolean result = count == 0 ? statement.execute(sql) : ((PreparedStatement) statement).execute();
      while (true) {
        warning(statement.getWarnings()); warning(connection.getWarnings());
        if (result) {
          try (ResultSet rows = statement.getResultSet()) {
            ResultSetMetaData meta = rows.getMetaData(); int columns = meta.getColumnCount();
            if (columns < 1 || columns > 10000) throw new SQLException("Invalid ASE result column count");
            int[] types = new int[columns]; StringBuilder header = new StringBuilder("M\t" + columns);
            for (int i = 0; i < columns; i++) {
              types[i] = meta.getColumnType(i + 1);
              header.append('\t').append(b64(meta.getColumnLabel(i + 1))).append('\t').append(type(types[i]));
              if (header.length() > MAX_FRAME) throw new SQLException("ASE metadata exceeds worker limit");
            }
            send(header.toString());
            while (rows.next()) {
              StringBuilder row = new StringBuilder("R\t" + columns);
              for (int i = 0; i < columns; i++) {
                row.append('\t').append(cell(rows, i + 1, types[i]));
                if (row.length() > MAX_FRAME) throw new SQLException("ASE result row exceeds worker limit");
              }
              warning(rows.getWarnings()); warning(statement.getWarnings()); warning(connection.getWarnings());
              send(row.toString());
              String[] ack = read();
              if (ack.length != 1 || !ack[0].equals("A")) throw new IOException("Missing row acknowledgement");
            }
            warning(rows.getWarnings());
          }
        } else {
          int countUpdated = statement.getUpdateCount();
          if (countUpdated == -1) break;
          send("U\t" + countUpdated);
        }
        result = statement.getMoreResults(Statement.CLOSE_CURRENT_RESULT);
      }
      warning(statement.getWarnings()); warning(connection.getWarnings());
    }
    if (!preserveSession) checkCharset(connection, timeout);
  }
  public static void main(String[] args) throws Exception {
    try {
      String[] config = read();
      if (config.length != 7 || !config[0].equals("I") || !CHARSETS.containsKey(config[5]))
        throw new IOException("Invalid JDBC startup frame");
      String url = text(config[1]), user = text(config[2]), password = text(config[3]), database = text(config[4]);
      if (!url.matches("jdbc:sybase:Tds:127\\.0\\.0\\.1:[0-9]{1,5}")) throw new IOException("JDBC requires loopback relay");
      charset = Charset.forName(CHARSETS.get(config[5]));
      charsetName = config[5];
      try { representable(user); representable(password); representable(database); }
      catch (CharacterCodingException e) { throw new IOException("Connection values cannot be represented in the selected ASE character set"); }
      Properties properties = new Properties(); properties.setProperty("user", user); properties.setProperty("password", password);
      properties.setProperty("CHARSET", config[5]);
      properties.setProperty("CHARSET_CONVERTER_CLASS", "com.sybase.jdbc4.charset.PureConverter");
      properties.setProperty("DISABLE_UNICHAR_SENDING", "true");
      properties.setProperty("REQUEST_HA_SESSION", "false");
      properties.setProperty("CONNECTION_FAILOVER", "false");
      DriverManager.setLoginTimeout(Integer.parseInt(config[6]));
      Class.forName("com.sybase.jdbc4.jdbc.SybDriver");
      try (Connection connection = DriverManager.getConnection(url, properties)) {
        if (!database.isEmpty()) connection.setCatalog(database);
        connection.clearWarnings();
        init(connection, config[5]);
        send("READY");
        while (true) {
          String[] request = read();
          if (request.length == 1 && request[0].equals("CLOSE")) break;
          try { execute(connection, request); }
          catch (Exception e) {
            if (e instanceof SessionEncodingException) throw e;
            send("E\t" + b64("ASE JDBC: " + e.getMessage() + ". The statement may already have executed; do not retry writes blindly."));
          }
          send("F");
        }
      }
    } catch (EOFException e) {
      // Parent closed stdin. try-with-resources closes the source session.
    } catch (Exception e) {
      send("E\t" + b64("ASE JDBC session: " + e.getMessage()));
      System.exit(1);
    }
  }
}
