import type { Pool } from 'pg'

/**
 * One database's shape, read from the catalog and sorted, so two databases can
 * be compared with a deep equal: the columns, the constraints, the indexes and
 * the triggers of every table in the current schema, and its functions.
 *
 * Read from the catalog rather than from `pg_dump`, so it works whatever
 * client is installed beside the server.
 */
export interface SchemaSnapshot {
  columns: string[]
  constraints: string[]
  indexes: string[]
  triggers: string[]
  functions: string[]
}

export async function schemaSnapshot(pool: Pool): Promise<SchemaSnapshot> {
  const lines = async (sql: string): Promise<string[]> =>
    (await pool.query<{ line: string }>(sql)).rows.map(row => row.line)

  return {
    columns: await lines(`
      select c.relname || '.' || a.attname || ' ' ||
             format_type(a.atttypid, a.atttypmod) ||
             case when a.attnotnull then ' not null' else '' end ||
             coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') ||
             case when a.attgenerated <> '' then ' generated ' || a.attgenerated::text
               else '' end as line
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = current_schema()
        and c.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
      order by line`),
    constraints: await lines(`
      select c.conrelid::regclass::text || ' ' || c.conname || ' ' ||
             pg_get_constraintdef(c.oid) as line
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      where n.nspname = current_schema() and c.conrelid <> 0
      order by line`),
    indexes: await lines(`
      select indexdef as line from pg_indexes
      where schemaname = current_schema()
      order by line`),
    triggers: await lines(`
      select pg_get_triggerdef(t.oid) as line
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and not t.tgisinternal
      order by line`),
    functions: await lines(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) ||
             ')' as line
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = current_schema()
      order by line`)
  }
}
