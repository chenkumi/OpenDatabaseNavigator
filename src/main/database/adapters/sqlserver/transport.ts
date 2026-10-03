import type { Connection } from '../../../../shared/types';

/** Native drivers need explicit identities when their TCP endpoint is relayed. */
export function sqlServerRelayTarget(connection: Connection) {
  if (!connection.readTimeout && !connection.writeTimeout) return undefined;
  const host = (connection.host || 'localhost').replace(/^tcp:/i, '');
  if (!host || /[\\,\s\0]/.test(host) || /^(lpc|np):/i.test(host))
    throw new Error('SQL Server network deadlines require a TCP host/port.');
  if (connection.sqlServerAuth === 'windows' && !connection.sqlServerSpn?.trim())
    throw new Error('Windows network deadlines require an explicit server SPN.');
  return {
    host,
    port: connection.port ?? 1433,
    connectionTimeout: connection.connectionTimeout ?? 10000,
  };
}

export function windowsConnectionString(connection: Connection, relayPort?: number) {
  const quote = (value: string) => `{${value.replaceAll('}', '}}')}}`;
  const host = connection.host ?? 'localhost';
  const server =
    host.includes('\\') || /^(?:lpc|np):/i.test(host) ? host : `${host},${connection.port ?? 1433}`;
  let result = `Driver={ODBC Driver 18 for SQL Server};Server=${quote(server)};Database=${quote(connection.database || 'master')};Trusted_Connection=Yes;Encrypt=${connection.tls ? 'Yes' : 'No'};TrustServerCertificate=No;`;
  if (connection.sqlServerSpn) result += `ServerSPN=${quote(connection.sqlServerSpn)};`;
  if (relayPort !== undefined) {
    const target = sqlServerRelayTarget(connection);
    if (!target) throw new Error('Network deadlines are not enabled.');
    // Address routes bytes; ServerSPN and HostnameInCertificate still identify
    // the actual server. Disable driver reconnects instead of replaying work.
    result += `Address=${quote(`tcp:127.0.0.1,${relayPort}`)};HostnameInCertificate=${quote(target.host)};ConnectRetryCount=0;`;
  }
  return result;
}
