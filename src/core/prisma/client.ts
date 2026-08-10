import { PrismaClient } from "@prisma/client";
import { isProduction } from "../../config/env.js";

export const prisma = new PrismaClient({
  log: isProduction ? ["error"] : ["query", "error", "warn"]
});
