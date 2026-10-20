import type { TaxSnapshot } from './contract.js';
/** Render only the historical snapshot; current settings never rewrite an issued PDF. */
export function taxPdfLines(raw: unknown, legacy: { subtotal: number; discount: number; tax: number; total: number }): string[] {
  const snapshot = raw as TaxSnapshot | null;
  if (snapshot?.version !== 1) return [`Subtotal: ${legacy.subtotal} | Discount: ${legacy.discount} | Tax: ${legacy.tax}`, `Total: ${legacy.total}`];
  return [snapshot.registrationNumber ? `Tax registration: ${snapshot.registrationNumber}` : '', `Prices ${snapshot.inclusive ? 'include' : 'exclude'} VAT`, `Taxable subtotal after discount: ${snapshot.subtotal}`,
    ...(snapshot.showBreakdown ? snapshot.breakdown.map(r => `${r.name} ${r.rateBps / 100}% on ${r.base}: ${r.kind === 'withhold' ? '-' : ''}${r.amount}`) : [`Tax: ${snapshot.tax}`, `Withholding: ${snapshot.withholding}`]),
    `Gross total: ${snapshot.grossTotal} | Payable: ${snapshot.payable}`].filter(Boolean);
}
