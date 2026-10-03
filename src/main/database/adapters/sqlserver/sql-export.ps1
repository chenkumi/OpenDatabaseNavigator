$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
[Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]::InvariantCulture
$config = $null
$server = $null
$locker = $null
$transaction = $null
function Send($message) { [Console]::WriteLine(($message | ConvertTo-Json -Compress -Depth 8)) }
function Write-Sql([string]$sql) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($sql)
    if ($bytes.Length -gt 16777216) { throw 'SQL export exceeds the 16 MiB SQL-file limit.' }
    for ($offset = 0; $offset -lt $bytes.Length; $offset += 49152) {
        $length = [Math]::Min(49152, $bytes.Length - $offset)
        Send @{ chunk = [Convert]::ToBase64String($bytes, $offset, $length) }
        if ([Console]::ReadLine() -ne 'ACK') { throw 'SQL export writer disconnected.' }
    }
}
function Quote-Identifier([string]$name) { return '[' + $name.Replace(']', ']]') + ']' }
function Query-Locked([string]$sql) {
    $command = $locker.CreateCommand()
    $command.Transaction = $transaction
    $command.CommandTimeout = [Math]::Max(1, [Math]::Ceiling($config.timeout / 1000))
    $command.CommandText = $sql
    try {
        $reader = $command.ExecuteReader()
        try {
            $table = [Data.DataTable]::new()
            $table.Load($reader)
            return ,$table
        } finally { $reader.Dispose() }
    } finally { $command.Dispose() }
}
try {
    try { $config = [Console]::ReadLine() | ConvertFrom-Json } catch { throw 'Invalid SQL export connection configuration.' }
    $module = Get-Module -ListAvailable SqlServer | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $module) { $module = Get-Module -ListAvailable SQLPS | Sort-Object Version -Descending | Select-Object -First 1 }
    if (-not $module) { throw 'SQL Server SQL export requires the SqlServer PowerShell module (or SQLPS on Windows). Install the module for the selected PowerShell host.' }
    Import-Module $module.Path -DisableNameChecking -WarningAction SilentlyContinue | Out-Null

    $context = [Microsoft.SqlServer.Management.Common.ServerConnection]::new()
    $builder = [Activator]::CreateInstance($context.SqlConnectionObject.GetType().Assembly.GetType($context.SqlConnectionObject.GetType().Namespace + '.SqlConnectionStringBuilder'))
    $hostName = if ($config.host) { [string]$config.host } else { 'localhost' }
    $builder['Data Source'] = if ($hostName.Contains('\') -or $hostName -match '^(lpc|np):') { $hostName } else { $hostName + ',' + $config.port }
    if ($config.relayPort) {
        if (-not $builder.GetType().GetProperty('HostNameInCertificate')) {
            throw 'SQL Server export network deadlines require the SqlServer PowerShell module with Microsoft.Data.SqlClient 5.0 or later. Update the module; TLS verification will not be weakened.'
        }
        $builder['Data Source'] = 'tcp:127.0.0.1,' + $config.relayPort
        # Keep server identity independent of the loopback transport endpoint,
        # including servers that require encryption despite Encrypt=False.
        $builder['Host Name In Certificate'] = $config.certificateHost
    }
    $builder['Initial Catalog'] = $config.database
    $builder['Integrated Security'] = [bool]$config.integrated
    if ($config.integrated -and $config.serverSpn) {
        if (-not $builder.GetType().GetProperty('ServerSPN')) {
            throw 'An explicit server SPN requires the SqlServer PowerShell module with Microsoft.Data.SqlClient 5.0 or later.'
        }
        $builder['Server SPN'] = [string]$config.serverSpn
    }
    if ($config.relayPort) { $builder['ConnectRetryCount'] = 0 }
    if (-not $config.integrated) { $builder['User ID'] = $config.username; $builder['Password'] = $config.password }
    $builder['Encrypt'] = if ($config.tls) { 'True' } else { 'False' }
    $builder['TrustServerCertificate'] = $false
    $builder['Pooling'] = $false
    $builder['Application Name'] = 'Database Workspace SQL export'
    $builder['Connect Timeout'] = [int][Math]::Max(1, [Math]::Ceiling($config.connectionTimeout / 1000))
    $context.ConnectionString = $builder.ConnectionString
    $context.StatementTimeout = [Math]::Max(1, [Math]::Ceiling($config.timeout / 1000))
    $server = [Microsoft.SqlServer.Management.Smo.Server]::new($context)
    # Connect explicitly: a failed lazy VersionMajor read can look like zero
    # and hide the actual login or certificate validation error.
    $context.Connect()
    if ($server.VersionMajor -lt 14) { throw 'SQL Server SQL export requires SQL Server 2017 or later.' }
    # Fetch system flags in the collection query instead of issuing a query for
    # every built-in procedure/function in each user database.
    foreach ($name in @('StoredProcedure','UserDefinedFunction','View','Table','UserDefinedDataType','UserDefinedTableType','UserDefinedType','XmlSchemaCollection')) {
        $type = [Microsoft.SqlServer.Management.Smo.Server].Assembly.GetType('Microsoft.SqlServer.Management.Smo.' + $name)
        if ($type.GetProperty('IsSystemObject')) { $server.SetDefaultInitFields($type, [string[]]@('IsSystemObject')) }
    }
    $database = $server.Databases[$config.database]
    if (-not $database -or $database.IsSystemObject) { throw 'Choose a user database for SQL export.' }

    $locker = [Activator]::CreateInstance($context.SqlConnectionObject.GetType())
    $locker.ConnectionString = $builder.ConnectionString
    $locker.Open()
    $transaction = $locker.BeginTransaction([Data.IsolationLevel]::Serializable)
    $permission = Query-Locked "SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS allowed"
    if ($permission.Rows[0].allowed -ne 1) { throw 'SQL export requires VIEW DEFINITION on the whole database to avoid silently omitting objects.' }
    if ($config.includeData) {
        if ((Query-Locked 'SELECT 1 AS enabled FROM sys.security_policies WHERE is_enabled=1').Rows.Count) { throw 'SQL data export cannot guarantee all rows while row-level security policies are enabled. Structure-only export remains available.' }
        if ((Query-Locked "SELECT 1 AS masked FROM sys.masked_columns WHERE is_masked=1 AND HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UNMASK')<>1").Rows.Count) { throw 'SQL data export requires database UNMASK permission for masked columns.' }
        if ((Query-Locked 'SELECT 1 AS encrypted FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id WHERE t.is_ms_shipped=0 AND c.encryption_type IS NOT NULL').Rows.Count) { throw 'Always Encrypted data needs a dedicated encrypted-data transfer. Structure-only export remains available.' }
        if ((Query-Locked 'SELECT 1 AS generated FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id WHERE t.is_ms_shipped=0 AND c.generated_always_type<>0').Rows.Count) { throw 'Temporal or ledger data needs a dedicated history-aware transfer. Structure-only export remains available.' }
    }
    $catalogSql = "SELECT object_id, schema_id, name, type, CONVERT(varchar(33),modify_date,126) AS modified FROM sys.objects WHERE is_ms_shipped=0 ORDER BY object_id"
    $before = (Query-Locked $catalogSql).Rows | ForEach-Object { ConvertTo-Json -Compress -InputObject @($_.object_id,$_.schema_id,$_.name,$_.type,$_.modified) }
    $tables = @($database.Tables | Where-Object { -not $_.IsSystemObject })
    $identityScripts = [Collections.Generic.List[string]]::new()
    foreach ($table in $tables) {
        if ($config.includeData) {
            # Hold every table's shared lock until schema and data are complete.
            $qualified = (Quote-Identifier $table.Schema) + '.' + (Quote-Identifier $table.Name)
            $hasRows = (Query-Locked ('SELECT TOP (1) 1 AS locked FROM ' + $qualified + ' WITH (TABLOCK,HOLDLOCK)')).Rows.Count -gt 0
            $literal = "N'" + $qualified.Replace("'", "''") + "'"
            $identity = Query-Locked ("SELECT CONVERT(varchar(100),last_value) AS last_value, CONVERT(varchar(100),IDENT_CURRENT(" + $literal + ")) AS current_value, CONVERT(varchar(100),increment_value) AS increment_value FROM sys.identity_columns WHERE object_id=OBJECT_ID(" + $literal + ")")
            if ($identity.Rows.Count) {
                $current = [string]$identity.Rows[0].current_value
                if ($current -notmatch '^-?\d+$') { throw 'Cannot read the current identity value.' }
                # A newly created empty table uses RESEED as its first value;
                # an emptied, previously used source instead advances by increment.
                if (-not $hasRows -and $identity.Rows[0].last_value -isnot [DBNull]) {
                    $current = ([Numerics.BigInteger]::Parse($current) + [Numerics.BigInteger]::Parse([string]$identity.Rows[0].increment_value)).ToString()
                }
                $identityScripts.Add('DBCC CHECKIDENT (' + $literal + ', RESEED, ' + $current + ") WITH NO_INFOMSGS;`nGO`n")
            }
        }
    }
    $urns = [Collections.Generic.List[Microsoft.SqlServer.Management.Sdk.Sfc.Urn]]::new()
    foreach ($schema in $database.Schemas) {
        if ($schema.ID -notin (@(1,2,3,4) + @(16384..16393))) { $urns.Add($schema.Urn) }
    }
    foreach ($collection in @('UserDefinedDataTypes','UserDefinedTableTypes','UserDefinedTypes','XmlSchemaCollections','Sequences','PartitionFunctions','PartitionSchemes','FullTextCatalogs','FullTextStopLists','Tables','Views','UserDefinedFunctions','StoredProcedures','Synonyms','Triggers','SecurityPolicies')) {
        if($config.includeData -and $collection -eq 'Triggers') { continue }
        foreach ($object in $database.$collection) {
            if ($object.PSObject.Properties['IsSystemObject'] -and $object.IsSystemObject) { continue }
            $urns.Add($object.Urn)
        }
    }
    $scripter = [Microsoft.SqlServer.Management.Smo.Scripter]::new($server)
    $options = $scripter.Options
    $versionName = 'Version' + $server.VersionMajor + '0'
    if (-not [Enum]::IsDefined([Microsoft.SqlServer.Management.Smo.SqlServerVersion], $versionName)) { throw 'Update the SqlServer PowerShell module to support this SQL Server version.' }
    $options.TargetServerVersion = [Enum]::Parse([Microsoft.SqlServer.Management.Smo.SqlServerVersion], $versionName)
    $options.TargetDatabaseEngineType = $server.DatabaseEngineType
    $options.TargetDatabaseEngineEdition = $database.DatabaseEngineEdition
    $options.ScriptSchema = $true
    $options.ScriptData = $false
    $options.WithDependencies = $false
    $options.IncludeDatabaseContext = $false
    $options.SchemaQualify = $true
    $options.SchemaQualifyForeignKeysReferences = $true
    $options.DriAll = $true
    $options.DriIncludeSystemNames = $true
    $options.Indexes = $true
    $options.ColumnStoreIndexes = $true
    $options.SpatialIndexes = $true
    $options.XmlIndexes = $true
    $options.FullTextIndexes = $true
    $options.Triggers = $true
    if($config.includeData) {
        $options.DriAll=$false; $options.DriAllConstraints=$false; $options.DriAllKeys=$false
        $options.DriPrimaryKey=$true; $options.DriUniqueKeys=$true; $options.DriDefaults=$true
        $options.Triggers=$false; $options.DriForeignKeys=$false; $options.DriChecks=$false
    }
    $options.ExtendedProperties = $true
    $options.Permissions = $true
    $options.ScriptOwner = $true
    $options.AnsiPadding = $false
    $options.ScriptDataCompression = $true
    $options.ContinueScriptingOnError = $false
    $options.IncludeHeaders = $false
    $options.ScriptBatchTerminator = $false
    Write-Sql "-- Database Workspace / SQL Server native SMO export`n-- Restore into an empty database with the original collation and required principals/filegroups.`n"
    Write-Sql "SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET QUOTED_IDENTIFIER ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF;`nGO`n"
    Send @{ progress = @{ tables = $tables.Count; rows = 0 } }
    foreach ($batch in $scripter.EnumScript($urns.ToArray())) {
        Write-Sql ($batch + "`nGO`n")
    }
    if($config.includeData) {
        $script:rowCount=0
        foreach($table in $tables) { Write-TableData $table }
        $post=[Collections.Generic.List[Microsoft.SqlServer.Management.Sdk.Sfc.Urn]]::new()
        foreach($table in $tables) {
            foreach($object in $table.ForeignKeys) {$post.Add($object.Urn)}
            foreach($object in $table.Checks) {$post.Add($object.Urn)}
            foreach($object in $table.Triggers) {if(-not $object.IsSystemObject){$post.Add($object.Urn)}}
        }
        foreach($trigger in $database.Triggers) {if(-not $trigger.IsSystemObject){$post.Add($trigger.Urn)}}
        $options.DriForeignKeys=$true; $options.DriChecks=$true; $options.Triggers=$true
        foreach($batch in $scripter.EnumScript($post.ToArray())) {Write-Sql ($batch+"`nGO`n")}
    }
    foreach ($identityScript in $identityScripts) { Write-Sql $identityScript }
    if($config.includeData) {
        # SQL Server has no read-only "peek next" or SETVAL. Reconstruct the
        # captured position on the destination only, without changing START WITH.
        $sequences=Query-Locked 'SELECT SCHEMA_NAME(schema_id) AS schema_name,name,CONVERT(varchar(100),start_value) AS start_value,CONVERT(varchar(100),current_value) AS current_value,CONVERT(varchar(100),increment) AS step,last_used_value FROM sys.sequences'
        foreach($sequence in $sequences.Rows) {
            if($sequence.last_used_value -is [DBNull]) {continue}
            $name=(Quote-Identifier $sequence.schema_name)+'.'+(Quote-Identifier $sequence.name)
            $position=[Numerics.BigInteger]::Parse([string]$sequence.start_value)
            $target=[Numerics.BigInteger]::Parse([string]$sequence.current_value)
            $originalStep=[Numerics.BigInteger]::Parse([string]$sequence.step)
            $started=$false
            $hops=0
            while($position -ne $target) {
                if(++$hops -gt 4) {throw 'Sequence position exceeds the supported SQL Server integer range.'}
                $distance=$target-$position
                $maxStep=[Numerics.BigInteger]::Parse('9223372036854775807')
                $step=if([Numerics.BigInteger]::Abs($distance) -gt $maxStep) {$maxStep*$distance.Sign} else {$distance}
                Write-Sql ('ALTER SEQUENCE '+$name+' INCREMENT BY '+$step.ToString()+";`nGO`n")
                if(-not $started) {Write-Sql ('SELECT NEXT VALUE FOR '+$name+";`nGO`n");$started=$true}
                Write-Sql ('SELECT NEXT VALUE FOR '+$name+";`nGO`n")
                $position+=$step
            }
            if(-not $started) {Write-Sql ('SELECT NEXT VALUE FOR '+$name+";`nGO`n")}
            else {Write-Sql ('ALTER SEQUENCE '+$name+' INCREMENT BY '+$originalStep.ToString()+";`nGO`n")}
        }
    }
    $after = (Query-Locked $catalogSql).Rows | ForEach-Object { ConvertTo-Json -Compress -InputObject @($_.object_id,$_.schema_id,$_.name,$_.type,$_.modified) }
    if (($before -join "`n") -cne ($after -join "`n")) { throw 'Database structure changed during SQL export. Retry after schema changes finish.' }
    $transaction.Rollback(); $transaction.Dispose(); $transaction = $null
    Send @{ done = $true }
} catch {
    $message = $_.Exception.Message
    $cause = $_.Exception.InnerException
    while ($cause) { $message += ' ' + $cause.Message; $cause = $cause.InnerException }
    if ($config.password) { $message = $message.Replace([string]$config.password, '[redacted]') }
    Send @{ error = $message }
    exit 1
} finally {
    if ($transaction) { try { $transaction.Rollback() } catch {}; $transaction.Dispose() }
    if ($locker) { $locker.Dispose() }
    if ($server) { $server.ConnectionContext.Disconnect() }
}
