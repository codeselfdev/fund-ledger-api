/** Public actions may open HTTPS pages or supported, access-checked app routes. */
export function validHttpsUrl(value: string) {
  if (value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return Boolean(url.hostname && !url.username && !url.password); }
  catch { return false; }
}
export function validNotificationLink(value: string) {
  if (validHttpsUrl(value)) return true;
  if (value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['fundnesta:', 'fundledger:'].includes(url.protocol) || url.username || url.password || url.port || url.pathname || url.hash) return false;
    const id = (key: string) => /^[\w-]{1,100}$/.test(url.searchParams.get(key) ?? '');
    if (url.hostname === 'open') return ['home', 'support', 'billing'].includes(url.searchParams.get('screen') ?? '') && [...url.searchParams.keys()].every(key => key === 'screen');
    if (url.hostname === 'support') return id('ticket_id') && id('tenant_id');
    return url.hostname === 'notification' && id('project_id') && ['none', 'dues', 'schedules', 'notices', 'pay'].includes(url.searchParams.get('destination') ?? '');
  } catch { return false; }
}
