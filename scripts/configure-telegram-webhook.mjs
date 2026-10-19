import 'dotenv/config';
import { pathToFileURL } from 'node:url';

export function buttonWebhookSettings(info,secret){
  if(!info?.url||!/^https:\/\//.test(info.url))throw Error('Register the existing HTTPS Telegram webhook before enabling button updates.');
  if(info.has_custom_certificate)throw Error('This webhook uses a custom certificate. Update allowed_updates through its existing deployment configuration.');
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(secret??''))throw Error('Configure TELEGRAM_WEBHOOK_SECRET to match the API webhook first.');
  const updates=info.allowed_updates;
  if(updates!==undefined&&(!Array.isArray(updates)||updates.some(value=>typeof value!=='string')))throw Error('Unexpected Telegram update configuration.');
  return{url:info.url,secret_token:secret,allowed_updates:updates?.length?[...new Set([...updates,'message','callback_query'])]:[],drop_pending_updates:false,...(info.max_connections?{max_connections:info.max_connections}:{}),...(info.ip_address?{ip_address:info.ip_address}:{})};
}
export async function configureTelegramButtons({apply=false,fetcher=fetch,token=process.env.TELEGRAM_BOT_TOKEN,secret=process.env.TELEGRAM_WEBHOOK_SECRET}={}){
  if(!token)throw Error('Configure TELEGRAM_BOT_TOKEN in the backend environment first.');
  const api=async(method,body)=>{
    let response;try{response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw Error('Telegram could not be reached. No automatic retry was made.');}
    const value=await response.json();if(!response.ok||!value.ok)throw Error('Telegram rejected the webhook request. Check the configured bot and deployment.');return value.result;
  };
  const info=await api('getWebhookInfo',{}),settings=buttonWebhookSettings(info,secret);
  const enabled=!info.allowed_updates?.length||info.allowed_updates.includes('message')&&info.allowed_updates.includes('callback_query');
  if(enabled)return'Telegram already delivers messages and button clicks to the existing webhook.';
  if(!apply)return'Telegram button clicks are filtered out. After deploying both services, run this command again with --apply to add callback_query and preserve queued updates.';
  await api('setWebhook',settings);
  return'Telegram button clicks enabled on the existing webhook. Existing allowed updates and queued events were preserved.';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(await configureTelegramButtons({apply:process.argv.includes('--apply')}));}catch(error){console.error(error.message);process.exitCode=1;}
}
