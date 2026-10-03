# Serialize values on SQL Server, never through JS numbers or CLR spatial types.
function Sql-Text([string]$value) { return "N'" + $value.Replace("'", "''") + "'" }
function Hex-Expression([string]$value, [string]$prefix, [string]$suffix) {
    return '(' + (Sql-Text $prefix) + '+CONVERT(nvarchar(max),CONVERT(varbinary(max),' + $value + '),2)+' + (Sql-Text $suffix) + ')'
}
function Value-Expression([string]$column, [string]$type, [int]$scale, [int]$size) {
    $expression = switch ($type) {
        { $_ -in @('bigint','int','smallint','tinyint','bit','decimal','numeric') } { 'CONVERT(nvarchar(100),' + $column + ')'; break }
        { $_ -in @('money','smallmoney') } { 'CONVERT(nvarchar(100),' + $column + ',2)'; break }
        { $_ -in @('float','real') } { 'CONVERT(nvarchar(100),' + $column + ',3)'; break }
        { $_ -in @('binary','varbinary','image') } { Hex-Expression $column '0x' ''; break }
        { $_ -in @('nvarchar','nchar','ntext') } { Hex-Expression ('CONVERT(nvarchar(max),'+$column+')') 'CONVERT(nvarchar(max),0x' ')'; break }
        { $_ -in @('varchar','char') } { Hex-Expression $column '0x' ''; break }
        'text' { Hex-Expression ('CONVERT(varchar(max),'+$column+')') '0x' ''; break }
        'xml' { Hex-Expression ('CONVERT(nvarchar(max),'+$column+')') 'CONVERT(xml,CONVERT(nvarchar(max),0x' '),1)'; break }
        { $_ -in @('geometry','geography') } { Hex-Expression ($column+'.Serialize()') ($type+'::Deserialize(0x') ')'; break }
        'hierarchyid' { Hex-Expression $column 'CONVERT(hierarchyid,0x' ')'; break }
        'uniqueidentifier' { (Sql-Text "CONVERT(uniqueidentifier,N'") + '+CONVERT(nvarchar(36),' + $column + ')+' + (Sql-Text "')"); break }
        { $_ -in @('date','datetime','smalldatetime','datetime2','time','datetimeoffset') } {
            $declaration = if ($type -in @('datetime2','time','datetimeoffset')) { $type+'('+$scale+')' } else { $type }
            (Sql-Text ('CONVERT('+$declaration+",N'")) + '+CONVERT(nvarchar(50),' + $column + ',127)+' + (Sql-Text "',127)"); break
        }
        'sql_variant' { Variant-Expression $column; break }
        default { throw ('SQL data export does not support the type ' + $type + '. No partial file will be saved.') }
    }
    return '(CASE WHEN '+$column+' IS NULL THEN N''NULL'' ELSE '+$expression+' END)'
}
function Variant-Expression([string]$column, [bool]$declare=$false) {
    $expression = 'CASE CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY('+ $column + ',''BaseType'')) '
    foreach ($type in @('bigint','int','smallint','tinyint','bit','decimal','numeric','money','smallmoney','float','real','binary','varbinary','nvarchar','nchar','varchar','char','uniqueidentifier','date','datetime','smalldatetime','datetime2','time','datetimeoffset')) {
        $readType = switch ($type) {
            { $_ -in @('nvarchar','nchar') } { 'nvarchar(4000)'; break }
            { $_ -in @('varchar','char') } { 'varchar(8000)'; break }
            { $_ -in @('binary','varbinary') } { 'varbinary(8000)'; break }
            { $_ -in @('decimal','numeric') } { 'sql_variant'; break }
            { $_ -in @('datetime2','time','datetimeoffset') } { $type+'(7)'; break }
            default { $type }
        }
        $value = if ($type -in @('decimal','numeric')) { 'CONVERT(nvarchar(100),'+$column+')' } elseif($type -in @('varchar','char','nvarchar','nchar','binary','varbinary')) { Hex-Expression $column '0x' '' } else { Value-Expression ('CONVERT('+$readType+','+$column+')') $type 7 0 }
        $declaration = Sql-Text $type
        if ($type -in @('decimal','numeric')) {
            $declaration += "+N'('+CONVERT(nvarchar(10),SQL_VARIANT_PROPERTY("+$column+",'Precision'))+N','+CONVERT(nvarchar(10),SQL_VARIANT_PROPERTY("+$column+",'Scale'))+N')'"
        } elseif ($type -in @('binary','varbinary','nvarchar','nchar','varchar','char')) {
            $divisor = if($type -in @('nvarchar','nchar')) { '/2' } else { '' }
            $declaration += "+N'('+CONVERT(nvarchar(10),CONVERT(int,SQL_VARIANT_PROPERTY("+$column+",'MaxLength'))"+$divisor+")+N')'"
        } elseif ($type -in @('datetime2','time','datetimeoffset')) {
            $declaration += "+N'('+CONVERT(nvarchar(10),SQL_VARIANT_PROPERTY("+$column+",'Scale'))+N')'"
        }
        $collation = if($type -in @('nvarchar','nchar','varchar','char')) { "+N' COLLATE '+CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY("+$column+",'Collation'))" } else { '' }
        $expression += ' WHEN '+(Sql-Text $type)+' THEN '+ $(if($declare) { '('+$declaration+')'+$collation } else { '('+$value+')' })
    }
    return $expression+' ELSE NULL END'
}
function Write-TableData($table) {
    $qualified=(Quote-Identifier $table.Schema)+'.'+(Quote-Identifier $table.Name)
    $literal=Sql-Text $qualified
    $columns=Query-Locked ("SELECT c.name, COALESCE(TYPE_NAME(c.system_type_id),t.name) AS type,c.scale,c.max_length,c.is_identity,c.collation_name FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID("+$literal+") AND c.is_computed=0 AND c.system_type_id<>189 ORDER BY c.column_id")
    $names=[Collections.Generic.List[string]]::new()
    $expressions=[Collections.Generic.List[string]]::new()
    $identity=$false
    $staged=[Collections.Generic.List[object]]::new()
    foreach($column in $columns.Rows) {
        $name=Quote-Identifier $column.name
        $names.Add($name)
        $value=Value-Expression $name $column.type $column.scale $column.max_length
        if($column.type -eq 'text') {
            if($column.collation_name -notmatch '^[A-Za-z0-9_]+$') { throw 'Invalid SQL Server collation metadata.' }
            $staged.Add(@{ index=$names.Count-1; declaration='varchar(max) COLLATE '+$column.collation_name })
        }
        if($column.type -eq 'sql_variant') { $staged.Add(@{index=$names.Count-1; expression=(Variant-Expression $name $true)}) }
        $expressions.Add($value)
        if($column.is_identity) { $identity=$true }
    }
    foreach($stage in $staged) {
        if($stage.expression) {$stage.metadata=$expressions.Count; $expressions.Add($stage.expression)}
    }
    if($identity) { Write-Sql ('SET IDENTITY_INSERT '+$qualified+" ON;`nGO`n") }
    $command=$locker.CreateCommand()
    $command.Transaction=$transaction
    $command.CommandTimeout=[Math]::Max(1,[Math]::Ceiling($config.timeout/1000))
    $command.CommandText='SELECT '+$(if($expressions.Count){$expressions -join ','}else{'1'})+' FROM '+$qualified
    try {
        $reader=$command.ExecuteReader()
        try {
            while($reader.Read()) {
                if($names.Count) {
                    $values=[Collections.Generic.List[string]]::new()
                    for($i=0;$i -lt $names.Count;$i++) {
                        if($reader.IsDBNull($i)) { throw 'SQL data serialization failed. No partial file will be saved.' }
                        $values.Add($reader.GetString($i))
                    }
                    if($staged.Count) {
                        # A typed staging column prevents SQL Server from decoding
                        # non-Unicode bytes using the destination database codepage.
                        $definitions=[Collections.Generic.List[string]]::new()
                        $stageValues=[Collections.Generic.List[string]]::new()
                        foreach($stage in $staged) {
                            $declaration=if($stage.expression) {if($reader.IsDBNull($stage.metadata)) {'varbinary(1)'} else {$reader.GetString($stage.metadata)}} else {$stage.declaration}
                            if($declaration -notmatch '^[A-Za-z0-9_]+(\((max|\d+)(,\d+)?\))?( COLLATE [A-Za-z0-9_]+)?$') {throw 'Invalid SQL variant type metadata.'}
                            $field='[v'+$stage.index+']'
                            $definitions.Add($field+' '+$declaration+' NULL')
                            $stageValues.Add($values[$stage.index])
                            $values[$stage.index]=$field
                        }
                        Write-Sql ('DECLARE @dw_values TABLE ('+($definitions -join ',')+'); INSERT INTO @dw_values VALUES ('+($stageValues -join ',')+'); INSERT INTO '+$qualified+' ('+($names -join ',')+') SELECT '+($values -join ',')+" FROM @dw_values;`nGO`n")
                    } else { Write-Sql ('INSERT INTO '+$qualified+' ('+($names -join ',')+') VALUES ('+($values -join ',')+");`nGO`n") }
                } else { Write-Sql ('INSERT INTO '+$qualified+" DEFAULT VALUES;`nGO`n") }
                $script:rowCount++
            }
        } finally { $reader.Dispose() }
    } finally { $command.Dispose() }
    if($identity) { Write-Sql ('SET IDENTITY_INSERT '+$qualified+" OFF;`nGO`n") }
    Send @{progress=@{tables=$tables.Count;rows=$script:rowCount;currentTable=$qualified}}
}
