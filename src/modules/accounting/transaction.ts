import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { conflict } from '../../core/http/api-error.js';
// Serializable transactions make retries safe across simultaneous payments,
// conversions and account credits. Unique request keys survive HTTP retries.
export async function financialTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, timeoutMs = 5000): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: timeoutMs });
        }
        catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code)) {
                if (attempt < 2)
                    continue;
                throw conflict('Another update is in progress. Please retry.');
            }
            throw e;
        }
    }
    throw conflict('Please retry this operation');
}
