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
import { Prisma } from "@prisma/client";
import { prisma } from "../core/prisma/client.js";
import { createTrialSubscription } from "../core/subscription/subscription.service.js";
import { createSessionToken, issueOtp } from "../modules/auth/auth.service.js";

type Args = {
  name: string;
  slug: string;
  adminName: string;
  adminMobile: string;
  adminEmail?: string;
  currency: string;
  trialDays: number;
  projectName: string;
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
  --trial-days <n>                default: 365
  --project-name <name>           default: Default Project
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

  return {
    name,
    slug,
    adminName,
    adminMobile,
    adminEmail: readArg(argv, "--admin-email"),
    currency: (readArg(argv, "--currency") ?? "BDT").toUpperCase(),
    trialDays,
    projectName: readArg(argv, "--project-name") ?? "Default Project",
    printOtp: hasFlag(argv, "--print-otp")
  };
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: args.name,
        slug: args.slug,
        currency: args.currency,
        plan: "free",
        contact: jsonValue({ subscription: createTrialSubscription(args.trialDays) })
      }
    });

    const project = await tx.project.create({
      data: {
        tenantId: tenant.id,
        name: args.projectName,
        totalShares: 1
      }
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: args.adminName,
        mobile: args.adminMobile,
        email: args.adminEmail
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        userId: user.id,
        role: "owner"
      }
    });

    await tx.account.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return { tenant, project, user };
  });

  const { token } = await createSessionToken({
    tenantId: result.tenant.id,
    userId: result.user.id,
    activeProjectId: result.project.id
  });

  console.log("\nSuper admin created successfully.\n");
  console.log(JSON.stringify({
    tenant_id: result.tenant.id,
    tenant_slug: result.tenant.slug,
    project_id: result.project.id,
    project_name: result.project.name,
    user_id: result.user.id,
    admin_name: result.user.name,
    admin_mobile: result.user.mobile,
    admin_email: result.user.email,
    role: "owner",
    token
  }, null, 2));

  if (args.printOtp) {
    const otp = await issueOtp(result.user.mobile, result.user.email);
    console.log("\nFirst login OTP (valid ~5 minutes):");
    console.log(`  mobile: ${result.user.mobile}`);
    console.log(`  otp:    ${otp.code}`);
    console.log(`  emailed: ${otp.emailed}`);
  }

  console.log(`
Use immediately:
  Authorization: Bearer <token>
  X-Project-Id: ${result.project.id}

Or login later:
  POST /v1/auth/otp/request  { "mobile": "${result.user.mobile}" }
  POST /v1/auth/login        { "mobile": "${result.user.mobile}", "otp": "<code>", "tenant_slug": "${result.tenant.slug}" }

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
