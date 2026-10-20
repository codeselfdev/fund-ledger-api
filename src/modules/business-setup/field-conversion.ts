import { Prisma } from '@prisma/client';
import { badRequest } from '../../core/http/api-error.js';
import { canConvertFieldType, type BusinessEntity, type FieldDefinition, type FieldConversionPreview, type ValueType } from './contract.js';
import { table } from './records.js';
import { type Scope } from './service.js';

/** The same token expression drives the preview and persisted JSONB conversion. */
function conversionSql(auth: Scope, entity: BusinessEntity, field: FieldDefinition, to: ValueType) {
  const source = Prisma.sql`SELECT id, attributes -> ${field.key} AS value FROM ${Prisma.raw(table[entity])}
    WHERE tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId}
      AND attributes ? ${field.key} AND attributes -> ${field.key} <> 'null'::jsonb`;
  // A single-choice option may itself contain a comma. Keep it as one choice.
  const parts = to === 'multi_select' && field.type !== 'select'
    ? Prisma.sql`regexp_split_to_table(source.value #>> '{}', ',') WITH ORDINALITY AS part(value, position)`
    : Prisma.sql`(SELECT source.value #>> '{}' AS value, 1 AS position) AS part`;
  // Match JavaScript trim()/field validation, including spaces copied from spreadsheets.
  const whitespace = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const tokens = Prisma.sql`SELECT source.id, btrim(part.value, ${whitespace}) AS value, part.position
    FROM source CROSS JOIN LATERAL ${parts}`;
  return { source, tokens };
}

export async function previewFieldConversion(db: Prisma.TransactionClient, auth: Scope, entity: BusinessEntity, field: FieldDefinition, to: ValueType, revision: number): Promise<FieldConversionPreview> {
  if (field.archived) throw badRequest('Restore this field before changing its type.');
  if (!canConvertFieldType(field.type, to)) throw badRequest('This type change cannot preserve saved values. Choose a supported choice type or add a new field.');
  const { source, tokens } = conversionSql(auth, entity, field, to);
  const [counts] = await db.$queryRaw<{ records: bigint; invalid: bigint }[]>(Prisma.sql`WITH source AS (${source})
    SELECT count(*) AS records, count(*) FILTER (WHERE jsonb_typeof(value) <> 'string') AS invalid FROM source`);
  if (counts.invalid) throw badRequest('Some saved values are not text. Correct them before changing this field to choices.');
  const values = await db.$queryRaw<{ value: string }[]>(Prisma.sql`WITH source AS (${source}), tokens AS (${tokens})
    SELECT DISTINCT value FROM tokens WHERE value <> '' ORDER BY value LIMIT 101`);
  const options = [...new Set([...field.options, ...values.map(row => row.value)])];
  if (options.length > 100) throw badRequest('This field has more than 100 distinct choices. Reduce its saved values before converting.');
  if (options.some(value => value.length > 100)) throw badRequest('A saved choice exceeds 100 characters. Shorten that value before converting.');
  return { fieldId: field.id, revision, fromType: field.type, toType: to, options, records: Number(counts.records) };
}

/** Caller holds the project settings lock; definition, records and audit commit together. */
export async function convertFieldValues(db: Prisma.TransactionClient, auth: Scope, entity: BusinessEntity, field: FieldDefinition, to: ValueType) {
  const { source, tokens } = conversionSql(auth, entity, field, to);
  // Deduplicate each record while retaining its original choice order. Empty values stay null.
  return db.$executeRaw(Prisma.sql`WITH source AS (${source}), tokens AS (${tokens}),
    distinct_values AS (SELECT id, value, min(position) AS position FROM tokens WHERE value <> '' GROUP BY id, value),
    converted AS (SELECT source.id, ${to === 'multi_select'
      ? Prisma.sql`COALESCE((SELECT jsonb_agg(value ORDER BY position) FROM distinct_values WHERE id = source.id), 'null'::jsonb)`
      : Prisma.sql`COALESCE((SELECT to_jsonb(value) FROM distinct_values WHERE id = source.id LIMIT 1), 'null'::jsonb)`} AS value FROM source)
    UPDATE ${Prisma.raw(table[entity])} AS record SET attributes = jsonb_set(record.attributes, ARRAY[${field.key}]::text[], converted.value, false), updated_at = now()
    FROM converted WHERE record.id = converted.id AND record.tenant_id = ${auth.tenantId} AND record.project_id = ${auth.projectId}`);
}
