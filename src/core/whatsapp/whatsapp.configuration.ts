type Environment = Record<string, string | undefined>;
export interface ConfigurationCheck { name: string; ok: boolean; requirement: string }
const value = (source: Environment, name: string) => source[name] ?? '';
const enabled = (source: Environment, name: string) => value(source, name) === 'true';

/** Operator diagnostics contain variable names and requirements, never their values. */
export function whatsappConfigurationDiagnostics(source: Environment = process.env) {
  const checks: ConfigurationCheck[] = [
    ...['WHATSAPP_ENABLED', 'WHATSAPP_GROUPS_ENABLED'].map(name => ({ name, ok: enabled(source, name), requirement: 'must be true' })),
    ...['WHATSAPP_WABA_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_CREDENTIALS_KEY'].map(name => ({ name, ok: !!value(source, name), requirement: 'must be set' })),
    { name: 'WHATSAPP_ACCESS_TOKEN', ok: value(source, 'WHATSAPP_ACCESS_TOKEN').length >= 20, requirement: 'must contain at least 20 characters' },
    { name: 'WHATSAPP_GRAPH_API_VERSION', ok: /^v\d+\.\d+$/.test(source.WHATSAPP_GRAPH_API_VERSION ?? 'v23.0'), requirement: 'must use the format v23.0; defaults to v23.0 when unset' },
    { name: 'AI_SERVICE_URL', ok: !!value(source, 'AI_SERVICE_URL'), requirement: 'must point to the deployed Fund Nesta AI service' },
    { name: 'AI_SERVICE_SHARED_SECRET', ok: value(source, 'AI_SERVICE_SHARED_SECRET').length >= 32, requirement: 'must contain at least 32 characters and match the AI service' },
  ];
  return { ready: checks.every(check => check.ok), checks };
}

export function managedWhatsAppConfiguration(source: Environment = process.env) {
  if (!whatsappConfigurationDiagnostics(source).ready) return null;
  return {
    waba: value(source, 'WHATSAPP_WABA_ID'), phone: value(source, 'WHATSAPP_PHONE_NUMBER_ID'),
    token: value(source, 'WHATSAPP_ACCESS_TOKEN'), version: source.WHATSAPP_GRAPH_API_VERSION ?? 'v23.0',
  };
}

export function logWhatsAppConfiguration(source: Environment = process.env) {
  if (!enabled(source, 'WHATSAPP_ENABLED') && !enabled(source, 'WHATSAPP_GROUPS_ENABLED')) return;
  const result = whatsappConfigurationDiagnostics(source);
  if (result.ready) console.log('[whatsapp] Managed group configuration is ready; provider eligibility and delivery require verification.');
  else console.warn(`[whatsapp] Managed group setup unavailable. Check runtime variables: ${result.checks.filter(check => !check.ok).map(check => `${check.name} (${check.requirement})`).join('; ')}. Run npm run whatsapp:check inside this API container.`);
}
