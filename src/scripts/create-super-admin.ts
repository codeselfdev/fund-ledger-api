/**
 * Bootstrap a fresh database with the first tenant + owner (super admin).
 *
 * Usage:
 *   npm run create:super-admin -- \
 *     --name "Acme Org" \
 *     --slug acme \
 *     --admin-name "Super Admin" \
 *     --admin-mobile "01700000000" \
 *     --admin-email "admin@acme.com" \
 *     --print-otp
 *
 * Production (inside container after build):
 *   npm run create:super-admin:prod -- --name "..." --slug "..." ...
 */
import { prisma } from "../core/prisma/client.js";
import { issueOtp } from "../modules/auth/auth.service.js";
import { provisionTenant } from "../modules/tenants/tenants.service.js";

type Args = {
  name: string;
  slug: string;
  adminName: string;
  adminMobile: string;
  adminEmail?: string;
  currency: string;
  trialDays: number;
  projectName: string;
  projectTotalShares: number;
  printOtp: boolean;
};

function usage(exitCode = 1): never {
  console.error(`Create the first tenant owner (super admin) on a fresh database.

Required:
  --name <org name>
  --slug <url-safe-slug>          e.g. acme-org
  --admin-name <full name>
  --admin-mobile <mobile>

Optional:
  --admin-email <email>           recommended (OTP login emails)
  --currency <ISO>                default: BDT
  --trial-days <n>                default: 182
  --project-name <name>           default: Default Project
  --total-shares <n>              default: 1
  --print-otp                     issue + print a one-time login code
`);
  process.exit(exitCode);
}

function readArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function hasFlag(argv: string[], flag: string) {
  return argv.includes(flag);
}

function parseArgs(argv: string[]): Args {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) usage(0);

  const name = readArg(argv, "--name");
  const slug = readArg(argv, "--slug");
  const adminName = readArg(argv, "--admin-name");
  const adminMobile = readArg(argv, "--admin-mobile");

  if (!name || !slug || !adminName || !adminMobile) {
    console.error("Missing required arguments.\n");
    usage(1);
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("--slug must match /^[a-z0-9-]+$/");
  }

  const trialDaysRaw = readArg(argv, "--trial-days") ?? "182";
  const trialDays = Number(trialDaysRaw);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 3650) {
    throw new Error("--trial-days must be an integer between 0 and 3650");
  }
  const totalSharesRaw = readArg(argv, "--total-shares") ?? "1";
  const projectTotalShares = Number(totalSharesRaw);
  if (!Number.isInteger(projectTotalShares) || projectTotalShares <= 0) {
    throw new Error("--total-shares must be a positive integer");
  }

  return {
    name,
    slug,
    adminName,
    adminMobile,
    adminEmail: readArg(argv, "--admin-email"),
    currency: (readArg(argv, "--currency") ?? "BDT").toUpperCase(),
    trialDays,
    projectName: readArg(argv, "--project-name") ?? "Default Project",
    projectTotalShares,
    printOtp: hasFlag(argv, "--print-otp")
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const existingSlug = await prisma.tenant.findUnique({ where: { slug: args.slug } });
  if (existingSlug) {
    throw new Error(`Tenant slug "${args.slug}" already exists`);
  }

  const existingMobile = await prisma.user.findFirst({
    where: { mobile: args.adminMobile, isActive: true }
  });
  if (existingMobile) {
    throw new Error(`Active user with mobile "${args.adminMobile}" already exists`);
  }

  const result = await provisionTenant({
    name: args.name,
    slug: args.slug,
    currency: args.currency,
    projectName: args.projectName,
    projectTotalShares: args.projectTotalShares,
    adminName: args.adminName,
    adminMobile: args.adminMobile,
    adminEmail: args.adminEmail,
    trialDays: args.trialDays,
    source: "cli"
  });

  console.log("\nSuper admin created successfully.\n");
  console.log(JSON.stringify({
    tenant_id: result.tenantId,
    tenant_slug: result.tenantSlug,
    project_id: result.defaultProjectId,
    project_name: result.projectName,
    user_id: result.ownerUserId,
    admin_name: result.ownerName,
    admin_mobile: result.ownerMobile,
    admin_email: result.ownerEmail,
    role: "owner",
    token: result.token
  }, null, 2));

  if (args.printOtp) {
    const otp = await issueOtp(result.ownerMobile, result.ownerEmail);
    console.log("\nFirst login OTP (valid ~5 minutes):");
    console.log(`  mobile: ${result.ownerMobile}`);
    console.log(`  otp:    ${otp.code}`);
    console.log(`  emailed: ${otp.emailed}`);
  }

  console.log(`
Use immediately:
  Authorization: Bearer <token>
  X-Project-Id: ${result.defaultProjectId}

Or login later:
  POST /v1/auth/otp/request  { "mobile": "${result.ownerMobile}" }
  POST /v1/auth/login        { "mobile": "${result.ownerMobile}", "otp": "<code>", "tenant_slug": "${result.tenantSlug}" }

Create a project:
  POST /v1/projects
  { "name": "My Project", "total_shares": 100 }

Invite a project admin:
  POST /v1/invitations
  {
    "name": "Project Admin",
    "mobile": "01800000000",
    "email": "admin@example.com",
    "role": "admin"
  }
`);
}

main()
  .catch((error) => {
    console.error("\nFailed to create super admin:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
