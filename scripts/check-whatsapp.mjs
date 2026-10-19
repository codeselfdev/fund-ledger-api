import dotenv from 'dotenv';
import { whatsappConfigurationDiagnostics, managedWhatsAppConfiguration } from '../dist/core/whatsapp/whatsapp.configuration.js';
import { checkWhatsAppGroupsAccess } from '../dist/core/whatsapp/whatsapp-provider-error.js';
dotenv.config();
const result = whatsappConfigurationDiagnostics();
if (process.argv.includes('--provider') && result.ready) {
  const config = managedWhatsAppConfiguration();
  result.provider = await checkWhatsAppGroupsAccess(config);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`WhatsApp group configuration: ${result.ready ? 'READY' : 'NOT READY'}`);
  for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'CHECK'} ${check.name}${check.ok ? '' : ` — ${check.requirement}`}`);
  console.log('Values and credentials are intentionally omitted. Configuration checks inspect the current API environment; they do not verify AI connectivity. Meta is contacted only with --provider.');
  if (result.provider) {
    console.log(`Meta Groups access: ${result.provider.accessible ? 'ACCESSIBLE' : 'BLOCKED'}`);
    if (!result.provider.accessible) console.log(JSON.stringify(result.provider));
    console.log('This was a read-only check. No group was created. Successful list access does not guarantee creation eligibility.');
  }
}
process.exitCode = result.ready && (!result.provider || result.provider.accessible) ? 0 : 1;
