/** Trusted operator CLI. Run on the backend host; never distribute platform credentials in the app. */
import { prisma } from "../core/prisma/client.js";
import { invoicesFromContact, issueInvoice, reviewInvoicePayment } from "../modules/subscription/billing.service.js";
const [action, tenantId, value, ...rest] = process.argv.slice(2);
try {
  if (!tenantId) throw new Error("Usage: subscription-billing list ORG | issue ORG AMOUNT INSTRUCTIONS | approve ORG INVOICE | reject ORG INVOICE REASON");
  if (action === "list") {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    console.log(JSON.stringify(invoicesFromContact(tenant.contact), null, 2));
  } else if (action === "issue") {
    const amount = Number(value), instructions = rest.join(" ").trim();
    if (!Number.isSafeInteger(amount) || amount <= 0 || !instructions) throw new Error("A positive whole-currency amount and payment instructions are required");
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    console.log(JSON.stringify(await issueInvoice(tenantId, amount, tenant.currency, instructions), null, 2));
  } else if (action === "approve" || action === "reject") {
    if (!value) throw new Error("Invoice ID is required");
    console.log(JSON.stringify(await reviewInvoicePayment(tenantId, value, action, rest.join(" ")), null, 2));
  } else throw new Error("Unknown billing action");
} catch (error) { console.error(error instanceof Error ? error.message : "Billing action failed"); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
