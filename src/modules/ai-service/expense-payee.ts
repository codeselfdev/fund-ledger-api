type Fields = Record<string, unknown>;
export const payeeNameKey = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim() : '';
/** A receipt merchant is a payee name, not a requirement to create a supplier. */
export function normalizeExpenseFields(kind: string, input: unknown): unknown {
  if (kind !== 'create_expense_draft' || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  const fields = { ...input } as Fields;
  if (!fields.payee_name) fields.payee_name = fields.supplier_name || fields.payee || fields.vendor;
  for (const key of ['supplier_name', 'payee', 'vendor']) delete fields[key];
  for (const key of ['supplier_id', 'payee_name', 'account_id', 'note']) {
    if (fields[key] == null || typeof fields[key] === 'string' && !String(fields[key]).trim()) delete fields[key];
    else if (typeof fields[key] === 'string') fields[key] = String(fields[key]).trim();
  }
  return fields;
}
export function receiptInvoiceParty(fields: Fields, targets: Fields = {}): Fields {
  const payee = targets.payee as { name?: string } | undefined, supplier = targets.supplier as { name?: string } | undefined;
  return { ...fields, payee_name: fields.payee_name || fields.supplier_name || payee?.name || supplier?.name };
}
/** Missing supplier IDs must never put every unrelated receipt in one duplicate bucket. */
export function sameReceiptInvoice(left: Fields, right: Fields) {
  if (!payeeNameKey(left.invoice_number) || payeeNameKey(left.invoice_number) !== payeeNameKey(right.invoice_number)) return false;
  if (left.supplier_id && right.supplier_id) return left.supplier_id === right.supplier_id;
  const a = payeeNameKey(left.payee_name ?? left.supplier_name), b = payeeNameKey(right.payee_name ?? right.supplier_name);
  if (a && b) return a === b;
  if (a || b || left.supplier_id || right.supplier_id) return false;
  return left.invoice_date === right.invoice_date && left.total === right.total && JSON.stringify(left.lines) === JSON.stringify(right.lines);
}
