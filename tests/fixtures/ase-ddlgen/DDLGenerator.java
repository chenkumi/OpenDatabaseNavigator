package com.sybase.ddlgen;

import java.io.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

// Test double, NOT SAP code. Exercises the real Java process boundary only.
public class DDLGenerator {
  public static void main(String[] args) throws Exception {
    Map<String, String> flags = new HashMap<>();
    for (String arg : args) if (arg.length() > 2) flags.put(arg.substring(0, 2), arg.substring(2));
    String password = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
    if (!"ext".equals(flags.get("-P"))) throw new Exception("Password must use stdin");
    for (String arg : args) if (password != null && !password.isEmpty() && arg.contains(password)) throw new Exception("Password leaked to arguments");
    String mode = flags.get("-U"), database = flags.get("-N");
    Path output = Path.of(flags.get("-O"));
    if ("hang".equals(mode)) { Thread.sleep(30000); return; }
    if ("network".equals(mode)) {
      String[] endpoint = flags.get("-S").split(":");
      try (Socket socket = new Socket(endpoint[0], Integer.parseInt(endpoint[1]))) {
        socket.getOutputStream().write("request".getBytes(StandardCharsets.UTF_8));
        socket.getInputStream().read();
        Thread.sleep(30000);
      }
      return;
    }
    if ("diagnostic".equals(mode)) { Files.writeString(Path.of(flags.get("-E")), "Error: " + password); }
    if ("wrongdb".equals(mode)) database = "other_database";
    if ("empty".equals(mode)) { Files.writeString(output, "-- no definitions\n"); return; }
    if ("invalid-utf8".equals(mode)) { Files.write(output, new byte[] {(byte)0xC3, (byte)0x28}); return; }
    if ("oversize".equals(mode)) { Files.writeString(output, " ".repeat(17 * 1024 * 1024)); return; }
    String sql = "use master\ngo\ncreate database [" + database + "]\ngo\nuse [" + database + "]\ngo\n"
      + "create table dbo.\"資料表\" (id int primary key, note varchar(100) default '中文😀')\ngo\n"
      + "create view dbo.v as select id from dbo.\"資料表\"\ngo\n"
      + "create procedure dbo.p as select 'USE other_database' as literal\ngo\n";
    if (!"RI,TR".equals(flags.get("-F"))) sql +=
      "alter table dbo.\"資料表\" add constraint fk_self foreign key (id) references dbo.\"資料表\"(id)\ngo\n"
      + "create trigger dbo.tr on dbo.\"資料表\" for insert as select 'trigger'\ngo\n";
    Files.writeString(output, sql, StandardCharsets.UTF_8);
    if ("nonzero".equals(mode)) System.exit(2);
  }
}
