import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { prisma } from "../../core/prisma/client.js";
import { ApiError, notFound } from "../../core/http/api-error.js";

const MAX_ROWS = 100000;
type Cell = string | number | boolean | null;
const date = (value: Date | null | undefined) => value?.toISOString() ?? "";
export async function organizationWorkbook(tenantId: string, projectId?: string) {
  const report = await prisma.$transaction(async tx => {
    const tenant = await tx.tenant.findUnique({  where: { id: tenantId } });
    if (!tenant) throw notFound("Organization not found");
    if (projectId && !await tx.project.findFirst({ where: { id: projectId, tenantId } })) throw notFound("Project not found in this organization");
    const scope = { tenantId, ...(projectId ? { projectId } : {}) };
    const [projects, members, dues, accounts, ledger, expenses, deposits, assets, documents, invoices, payments] = await Promise.all([
      tx.project.findMany({ where: { tenantId, ...(projectId ? { id: projectId } : {}) }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.member.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.due.findMany({ where: scope, include: { schedule: { select: { name: true } } }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.account.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.accountTransaction.findMany({ where: scope, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_ROWS + 1 }),
      tx.expense.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.deposit.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.fixedAsset.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.businessDocument.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.billingInvoice.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
      tx.billingPayment.findMany({ where: scope, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }),
    ]);
    const groups = [projects, members, dues, accounts, ledger, expenses, deposits, assets, documents, invoices, payments];
    if (groups.some(rows => rows.length > MAX_ROWS) || groups.reduce((n, rows) => n + rows.length, 0) > 300000) throw new ApiError(413, "EXPORT_TOO_LARGE", "This export exceeds its safe size. Export one project at a time; no rows have been silently omitted.");
    const names = new Map(projects.map(p => [p.id, p.name])), memberNames = new Map(members.map(m => [m.id, m.name])), accountNames = new Map(accounts.map(a => [a.id, a.name]));
    const grouped = new Map<string, typeof dues>();
    for (const due of dues) { const rows = grouped.get(due.memberId) ?? []; rows.push(due); grouped.set(due.memberId, rows); }
    const confirmedDeposits = new Map<string,number>();
    for (const deposit of deposits) if(deposit.status==="confirmed") confirmedDeposits.set(deposit.memberId,(confirmedDeposits.get(deposit.memberId)??0)+deposit.amount-deposit.refundedAmount);
    const remaining = (d: typeof dues[number]) => Math.max(0, d.amount - d.waivedAmount - d.paidAmount) + Math.max(0, d.penaltyDue - d.penaltyPaid);
    const sheets: { name: string; rows: Cell[][] }[] = [];
    const add = (name: string, rows: Cell[][]) => sheets.push({ name, rows });
    add("Summary", [["Metric", "Value"], ["Organization", tenant.name], ["Organization ID", tenant.id], ["Currency", tenant.currency], ["Generated at (UTC)", new Date().toISOString()], ["Project scope", projectId ?? "All projects"], ["Projects", projects.length], ["Members", members.length], ["Paid against dues (includes opening history)", dues.reduce((n,d) => n+d.paidAmount+d.penaltyPaid,0)], ["Outstanding dues (includes penalties)", dues.reduce((n,d) => n+remaining(d),0)], ["Account balances", accounts.reduce((n,a) => n+a.balance,0)], ["Notes", "Amounts are whole currency units. Historical paid balances do not create cash receipts. Income contains manual income rows; the Ledger includes all account movements. Paid against dues and confirmed deposits are separate measures, not amounts to add together."]]);
    add("Projects", [["Project ID", "Project", "Type", "Active", "Total shares"], ...projects.map(p => [p.id,p.name,p.projectType,p.isActive,p.totalShares])]);
    add("Member summary", [["Project ID","Project","Member ID","MID","Member","Mobile","Email","Shares","Status","Assessed principal","Waived principal","Paid principal","Paid penalties","Outstanding","Confirmed deposits net refunds"], ...members.map(m => { const rows = grouped.get(m.id) ?? []; return [m.projectId,names.get(m.projectId)??"",m.id,m.mid??"",m.name,m.mobile,m.email??"",m.shares,m.status,rows.reduce((n,d)=>n+d.amount,0),rows.reduce((n,d)=>n+d.waivedAmount,0),rows.reduce((n,d)=>n+d.paidAmount,0),rows.reduce((n,d)=>n+d.penaltyPaid,0),rows.reduce((n,d)=>n+remaining(d),0),confirmedDeposits.get(m.id)??0]; })]);
    add("Member dues", [["Project","Member ID","Member","Schedule","Due date","Assessed","Waived","Paid","Penalty due","Penalty paid","Outstanding","Status"], ...dues.map(d=>[names.get(d.projectId)??"",d.memberId,memberNames.get(d.memberId)??"",d.schedule.name,date(d.dueDate),d.amount,d.waivedAmount,d.paidAmount,d.penaltyDue,d.penaltyPaid,remaining(d),d.status])]);
    add("Bank and cash summary", [["Project","Account ID","Account","Type","Bank","Account holder","Account number","Branch","Balance"], ...accounts.map(a=>[names.get(a.projectId)??"",a.id,a.name,a.type,a.bankName??"",a.accountName??"",a.accountNumber??"",a.branchName??"",a.balance])]);
    add("Ledger", [["Project","Account","Transaction ID","Occurred at","Created at","Direction","Amount","Balance after","Reference type","Reference ID","Description"], ...ledger.map(t=>[names.get(t.projectId)??"",accountNames.get(t.accountId)??"",t.id,date(t.occurredOn??t.createdAt),date(t.createdAt),t.direction,t.amount,t.balanceAfter,t.referenceType??"",t.referenceId??"",t.description??""])]);
    add("Expenses", [["Project","Expense ID","Title","Amount","Status","Category","Vendor","Expense date","Paid at","Account ID","Attachment ID"], ...expenses.map(e=>[names.get(e.projectId)??"",e.id,e.title,e.amount,e.status,e.category,e.vendor??"",date(e.expenseDate),date(e.paidAt),e.paidAccountId??e.accountId??"",e.docFileId??""])]);
    add("Income", [["Project","Income ID","Account","Amount","Date","Source","Description","Category ID","Customer ID"], ...ledger.filter(t=>t.referenceType==="income"&&t.direction==="money_in").map(t=>[names.get(t.projectId)??"",t.id,accountNames.get(t.accountId)??"",t.amount,date(t.occurredOn??t.createdAt),t.incomeSource??"",t.description??"",t.incomeCategoryId??"",t.incomeCustomerId??""])]);
    add("Deposits", [["Project","Deposit ID","Member ID","Member","Amount","Refunded","Method","Status","Reference","Submitted at","Confirmed at","Proof ID"], ...deposits.map(d=>[names.get(d.projectId)??"",d.id,d.memberId,memberNames.get(d.memberId)??"",d.amount,d.refundedAmount,d.method,d.status,d.reference??"",date(d.createdAt),date(d.confirmedAt),d.proofFileId??""])]);
    add("Fixed assets", [["Project","Asset ID","Code","Name","Category","Cost","Residual","Life months","Status","Purchase date","Location","Invoice attachment ID"], ...assets.map(a=>[names.get(a.projectId)??"",a.id,a.code,a.name,a.category,a.cost,a.residual,a.lifeMonths,a.status,date(a.purchaseDate),a.location,a.invoiceUploadId??""])]);
    const recordSheet = (name: string, rows: object[]) => {
      const keys = rows.length ? Object.keys(rows[0]!).filter(k => !["lines","config","metadata"].includes(k)) : ["No records"];
      add(name,[keys,...rows.map(row=>keys.map(key=>{ const value=(row as Record<string,unknown>)[key]; return value instanceof Date ? date(value) : value == null ? "" : typeof value === "object" ? JSON.stringify(value) : typeof value === "number" || typeof value === "boolean" ? value : String(value); }))]);
    };
    recordSheet("Accounting documents",documents); recordSheet("Billing invoices",invoices); recordSheet("Billing payments",payments);
    return { tenant, sheets };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60000 });
  const book = XLSX.utils.book_new();
  for (const sheet of report.sheets) {
    // Explicit string cells preserve mobile/account numbers and never execute user text as formulas.
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    ws["!cols"] = sheet.rows[0]!.map((_,i)=>({ wch: Math.min(52, Math.max(16,...sheet.rows.slice(0,100).map(row=>String(row[i]??"").length+2))) }));
    ws["!autofilter"] = { ref: ws["!ref"] ?? "A1" };
    XLSX.utils.book_append_sheet(book,ws,sheet.name);
  }
  return { filename: `fundnesta-${report.tenant.slug.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,70)}-${new Date().toISOString().slice(0,10)}.xlsx`, buffer: XLSX.write(book,{ type: "buffer", bookType: "xlsx", compression: true }) as Buffer };
}
