type AuthResult = { oauthInfo?: { code?: unknown } };
interface SdkHost { setHost(host: string): unknown; getHost(): string }
interface OfficialSdk {
  hostConfig: { account: SdkHost; webApi: SdkHost };
  user: {
    auth(options: { oauth: { appCode: string; grantType: number }; thirdPartyInfo: boolean }, callback: (status: number, result?: AuthResult) => void): Promise<unknown> | void;
    API: { clearToken(): Promise<unknown> | void };
  };
}
declare global {
  interface Window {
    _GL_WEB_SDK_INIT_OPTIONS?: { language: string };
    _GL_ACCOUNT_SDK_INIT_OPTIONS?: { language: string; devOptions: { accountServerHost: string; webApiServerHost: string } };
    _GL_WEB_SDK_CALLBACK_QUEUE?: Array<() => void>;
    GL_WEB_SDK?: OfficialSdk;
  }
}
let pending: Promise<OfficialSdk> | undefined;
function localHosts(sdk: OfficialSdk): OfficialSdk {
  const account = `${window.location.origin}/api/sdk/account`, web = `${window.location.origin}/api/sdk/web`;
  if (!sdk.hostConfig?.account?.setHost || !sdk.hostConfig?.webApi?.setHost || !sdk.user?.API?.clearToken) throw new Error('官方 SDK 不再提供已驗證的本機接入設定，請停止登入。');
  sdk.hostConfig.account.setHost(account); sdk.hostConfig.webApi.setHost(web);
  if (sdk.hostConfig.account.getHost() !== account || sdk.hostConfig.webApi.getHost() !== web) throw new Error('官方 SDK 未套用本機代理設定，請停止登入。');
  return sdk;
}
export function loadOfficialSdk(): Promise<OfficialSdk> {
  if (window.GL_WEB_SDK) return Promise.resolve(localHosts(window.GL_WEB_SDK));
  if (pending) return pending;
  pending = new Promise((resolveSdk, reject) => {
    window._GL_WEB_SDK_INIT_OPTIONS = { language: 'zh-tw' };
    // 只改帳號 SDK 的 API host；entry 的公開資產與灰度設定仍從官方載入。
    window._GL_ACCOUNT_SDK_INIT_OPTIONS = { language: 'zh-tw', devOptions: {
      accountServerHost: `${window.location.origin}/api/sdk/account`, webApiServerHost: `${window.location.origin}/api/sdk/web`,
    } };
    const timer = window.setTimeout(() => reject(new Error('官方登入元件載入逾時。請重新整理後再試。')), 20_000);
    window._GL_WEB_SDK_CALLBACK_QUEUE ??= [];
    window._GL_WEB_SDK_CALLBACK_QUEUE.push(() => {
      window.clearTimeout(timer);
      try {
        if (window.GL_WEB_SDK) resolveSdk(localHosts(window.GL_WEB_SDK));
        else reject(new Error('官方登入元件未就緒。'));
      } catch (error) { reject(error); }
    });
    const script = document.createElement('script');
    script.src = 'https://web-api.gryphline.com/static/gl_web_sdk/sdk.entry.js';
    script.referrerPolicy = 'no-referrer';
    script.onerror = () => { window.clearTimeout(timer); reject(new Error('無法載入官方登入元件。')); };
    document.head.appendChild(script);
  });
  return pending;
}
export async function clearOfficialSdkSession(): Promise<void> {
  // SDK 先清記憶體 cache 才呼叫本機 store；後端即使已過期，也不保留 SDK token cache。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve(window.GL_WEB_SDK?.user.API.clearToken()), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
  } catch { /* 本機連線仍由伺服器 clear 強制失效。 */ }
  finally { clearTimeout(timer); }
}
function notCancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('此登入已取消。'); }
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  notCancelled(signal);
  let aborted!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    aborted = () => reject(new Error('此登入已取消。'));
    signal.addEventListener('abort', aborted, { once: true });
  });
  try { const result = await Promise.race([operation, cancellation]); notCancelled(signal); return result; }
  finally { signal.removeEventListener('abort', aborted); }
}
export async function authorizeWithOfficialSdk(onCode: (code: string) => Promise<void>, signal: AbortSignal): Promise<'connected' | 'cancelled'> {
  notCancelled(signal);
  const sdk = await cancellable(loadOfficialSdk(), signal);
  notCancelled(signal);
  await cancellable(Promise.resolve(sdk.user.API.clearToken()), signal);
  notCancelled(signal);
  return new Promise((resolveAuth, reject) => {
    let settled = false;
    const finish = () => { settled = true; window.clearTimeout(timeout); signal.removeEventListener('abort', cancel); };
    const fail = (message: string) => { if (!settled) { finish(); reject(new Error(message)); } };
    const cancel = () => fail('此登入已取消。');
    const timeout = window.setTimeout(() => fail('登入等待逾時，請重新整理後再試。'), 5 * 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      Promise.resolve(sdk.user.auth({ oauth: { appCode: '6eb76d4e13aa36e6', grantType: 0 }, thirdPartyInfo: false }, (status, result) => {
        if (settled) return;
        finish();
        if (status === 2) { resolveAuth('cancelled'); return; }
        let code = status === 0 ? result?.oauthInfo?.code : undefined;
        if (typeof code !== 'string' || !code || code.length > 4096) { reject(new Error('官方登入未回傳可用的授權碼。')); return; }
        // 完整 SDK 回應可能含秘密，只交付本次 code，不序列化或保留回應。
        try { const exchange = onCode(code); code = undefined; exchange.then(() => resolveAuth('connected'), reject); }
        catch (error) { code = undefined; reject(error); }
      })).catch(() => fail('官方登入未完成，可能需要重新登入或處理官方驗證。'));
    } catch { fail('官方登入未完成，可能需要重新登入或處理官方驗證。'); }
  });
}
