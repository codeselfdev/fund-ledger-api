type FailureCategory = 'credentials' | 'permissions' | 'groups_access' | 'request' | 'rate_limit' | 'provider';

/** Never return provider-controlled text, identifiers or credentials to customers or logs. */
export function whatsappProviderFailure(status: number, payload: unknown) {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const candidate = body.error;
  const error = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  const numeric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const code = numeric(error.code), subcode = numeric(error.error_subcode);
  const details = error.error_data && typeof error.error_data === 'object' ? (error.error_data as Record<string, unknown>).details : '';
  const text = `${typeof error.message === 'string' ? error.message.slice(0, 2000) : ''} ${typeof details === 'string' ? details.slice(0, 2000) : ''}`;
  let category: FailureCategory = 'provider';
  if (code === 190 || status === 401) category = 'credentials';
  else if (/(not eligible|ineligible|not enabled|not available|not supported|official business account)/i.test(text) && /group|official business account/i.test(text)) category = 'groups_access';
  else if (code === 10 || code === 200 || status === 403) category = 'permissions';
  else if ([4, 17, 32, 613, 80007].includes(code ?? -1) || status === 429) category = 'rate_limit';
  else if (code === 100 || status === 400 || status === 404) category = 'request';
  const messages: Record<FailureCategory, string> = {
    credentials: "Fund Nesta's WhatsApp connection needs renewal. Please contact Fund Nesta support.",
    permissions: "Fund Nesta's WhatsApp account needs permission to create groups. Please contact Fund Nesta support.",
    groups_access: "WhatsApp has not enabled group creation for Fund Nesta's number. Please contact Fund Nesta support.",
    request: "WhatsApp rejected the group setup. Please contact Fund Nesta support.",
    rate_limit: 'WhatsApp is receiving too many requests. Please wait before trying again.',
    provider: 'WhatsApp could not create this group. Please contact Fund Nesta support.',
  };
  const reference = `WA-${code ?? `HTTP${status}`}${subcode === null ? '' : `-${subcode}`}`;
  return { http_status: status, code, subcode, category, reference, customer_message: `${messages[category]} (${reference})` };
}

/** Read-only provider check. It never creates a group or returns the groups themselves. */
export async function checkWhatsAppGroupsAccess(config: { version: string; phone: string; token: string }, request: typeof fetch = fetch) {
  try {
    const response = await request(`https://graph.facebook.com/${config.version}/${encodeURIComponent(config.phone)}/groups?limit=1`, {
      redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${config.token}` },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return { accessible: false, ...whatsappProviderFailure(response.status, payload) };
    if (!payload || typeof payload !== 'object' || !('data' in payload)) return { accessible: false, category: 'unexpected_response', http_status: response.status };
    return { accessible: true, http_status: response.status };
  } catch {
    return { accessible: false, category: 'network', customer_message: 'The API could not reach WhatsApp. Check outbound connectivity.' };
  }
}
