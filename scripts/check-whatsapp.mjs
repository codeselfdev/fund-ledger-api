import dotenv from 'dotenv';
import { whatsappConfigurationDiagnostics } from '../dist/core/whatsapp/whatsapp.configuration.js';
dotenv.config();
const result = whatsappConfigurationDiagnostics();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`WhatsApp group configuration: ${result.ready ? 'READY' : 'NOT READY'}`);
  for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'CHECK'} ${check.name}${check.ok ? '' : ` — ${check.requirement}`}`);
  console.log('Values and credentials are intentionally omitted. This checks the current API process environment; it does not contact Meta or verify the AI service is reachable.');
}
process.exitCode = result.ready ? 0 : 1;
