import { sqlTokens, keyword } from '../database/object-sql';
import { assertSingleStatement } from './single-statement';

// ASE syntax (including @@variables, ? parameters and bitwise catalog queries)
// is not fully supported by node-sql-parser. This deliberately limited SELECT
// profile rejects batches, session changes, writes and non-allowlisted functions.
const forbidden = new Set(
  `INTO INSERT UPDATE DELETE REPLACE MERGE CREATE ALTER DROP TRUNCATE
EXEC EXECUTE CALL SET USE DECLARE BEGIN END COMMIT ROLLBACK SAVE TRANSACTION
GRANT REVOKE DENY PRINT RAISERROR WAITFOR DBCC DUMP LOAD DISK SHUTDOWN KILL
CHECKPOINT RECONFIGURE IF WHILE RETURN GOTO BREAK CONTINUE READTEXT WRITETEXT
UPDATETEXT BULK LOCK HOLDLOCK FOR GO`.split(/\s+/),
);
const functions = new Set(
  `ABS ROUND CEIL CEILING FLOOR LOWER UPPER LENGTH CHAR_LENGTH
COALESCE NULLIF ISNULL CONCAT SUBSTR SUBSTRING LTRIM RTRIM COUNT SUM AVG MIN MAX
CAST CONVERT DATALENGTH CHARINDEX GETDATE DATEADD DATEDIFF DATEPART DATENAME
OBJECT_ID INDEX_COL INDEX_COLORDER COL_NAME DB_NAME USER_NAME SUSER_NAME`.split(/\s+/),
);
const grouping = new Set([
  'IN',
  'EXISTS',
  'NOT',
  'AND',
  'OR',
  'SELECT',
  'FROM',
  'WHERE',
  'ON',
  'AS',
  'BY',
]);

export function assertAseReadOnly(sql: string) {
  assertSingleStatement(sql, 'sybase');
  const tokens = sqlTokens(sql, 'sybase');
  if (!keyword(tokens[0], 'SELECT')) throw new Error('ASE accepts only read-only SELECT queries.');
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const word = token.value.toUpperCase();
    if (token.quoted) continue;
    if (forbidden.has(word))
      throw new Error('ASE read-only query contains a prohibited operation.');
    if (
      word === 'SELECT' &&
      i > 0 &&
      !keyword(tokens[i - 1], '(') &&
      !keyword(tokens[i - 1], 'UNION') &&
      !(keyword(tokens[i - 1], 'ALL') && keyword(tokens[i - 2], 'UNION'))
    )
      throw new Error('ASE SELECT batches are disabled.');
    if (word === '@') {
      if (
        keyword(tokens[i + 1], '@') &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[i + 2]?.value ?? '')
      )
        i += 2;
      else throw new Error('ASE session variable assignment is disabled.');
    }
    if (word === '(') {
      depth++;
      const previous = tokens[i - 1];
      if (previous && (previous.quoted || /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(previous.value))) {
        const name = previous.value.toUpperCase();
        // Sized types ONLY in CONVERT's first argument, never general functions.
        const convertTypePosition =
          keyword(tokens[i - 3], 'CONVERT') && keyword(tokens[i - 2], '(');
        const convertVarcharType =
          convertTypePosition &&
          name === 'VARCHAR' &&
          !tokens[i + 1]?.quoted &&
          /^\d{1,3}$/.test(tokens[i + 1]?.value ?? '') &&
          Number(tokens[i + 1].value) >= 1 &&
          Number(tokens[i + 1].value) <= 255 &&
          keyword(tokens[i + 2], ')') &&
          keyword(tokens[i + 3], ',');
        const convertNumericType =
          convertTypePosition &&
          ['NUMERIC', 'DECIMAL'].includes(name) &&
          !tokens[i + 1]?.quoted &&
          !tokens[i + 3]?.quoted &&
          /^\d{1,2}$/.test(tokens[i + 1]?.value ?? '') &&
          /^\d{1,2}$/.test(tokens[i + 3]?.value ?? '') &&
          Number(tokens[i + 1].value) >= 1 &&
          Number(tokens[i + 1].value) <= 38 &&
          Number(tokens[i + 3].value) <= Number(tokens[i + 1].value) &&
          keyword(tokens[i + 2], ',') &&
          keyword(tokens[i + 4], ')') &&
          keyword(tokens[i + 5], ',');
        if (
          previous.quoted ||
          (!grouping.has(name) &&
            !functions.has(name) &&
            !convertVarcharType &&
            !convertNumericType) ||
          keyword(tokens[i - 2], '.')
        )
          throw new Error('ASE query contains an untrusted function.');
      }
    } else if (word === ')' && --depth < 0) throw new Error('Unbalanced ASE query parentheses.');
  }
  if (depth !== 0) throw new Error('Unbalanced ASE query parentheses.');
}
