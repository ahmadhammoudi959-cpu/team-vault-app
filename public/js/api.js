// Same-origin JSON calls. The X-Vault header is required by the server on every write,
// which blocks cross-site request forgery.

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data || {};
  }
}

let onSessionLost = null;
export const setSessionLostHandler = (fn) => {
  onSessionLost = fn;
};

async function call(method, url, body) {
  const opt = { method, headers: { 'X-Vault': '1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${url}`, opt);
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const code = (data && data.error) || (res.status === 404 ? 'gone' : `http_${res.status}`);
    if (code === 'no_session' && onSessionLost) onSessionLost();
    throw new ApiError(res.status, code, data);
  }
  return data;
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body = {}) => call('POST', url, body),
  put: (url, body = {}) => call('PUT', url, body),
  del: (url) => call('DELETE', url),
};

const MESSAGES = {
  network: 'تعذّر الاتصال بالسيرفر. تأكد من الإنترنت وحاول مرة أخرى. (إذا كان الموقع نائمًا قد يستغرق التشغيل دقيقة)',
  bad_credentials: 'اسم المستخدم أو كلمة السر الرئيسية أو رمز التحقق غير صحيح.',
  bad_password: 'كلمة السر الرئيسية غير صحيحة.',
  bad_totp: 'رمز التحقق غير صحيح أو انتهت صلاحيته. انتظر الرمز التالي في التطبيق واكتبه.',
  rate_limited: 'محاولات كثيرة خلال وقت قصير. انتظر قليلًا ثم حاول مرة أخرى.',
  invite_invalid: 'رابط الدعوة غير صالح، أو استُخدم من قبل، أو انتهت صلاحيته. اطلب رابطًا جديدًا من المدير.',
  username_taken: 'اسم المستخدم هذا مستخدم بالفعل. اختر اسمًا آخر.',
  key_changed: 'تم تغيير مفتاح الخزنة من المدير. ستُقفل الخزنة الآن، افتحها مرة أخرى.',
  vault_changed: 'حدث تعديل على الخزنة أثناء العملية. أعد المحاولة.',
  billing_changed: 'عدّل مدير آخر بيانات الفواتير في نفس اللحظة. أعد المحاولة.',
  device_blocked: 'هذا الجهاز محظور من المدير.',
  no_session: 'انتهت الجلسة. سجّل الدخول مرة أخرى.',
  forbidden: 'ليست لديك صلاحية لهذه العملية.',
  ticket_expired: 'انتهت مهلة الإعداد. سجّل الدخول مرة أخرى.',
  setup_restart: 'انتهت جلسة الإعداد. ابدأ من جديد.',
  last_admin: 'لا يمكن تنفيذ ذلك: يجب أن يبقى مدير واحد على الأقل.',
  not_self: 'لا يمكنك تنفيذ هذا الإجراء على حسابك أو جهازك الحالي.',
  use_rotation: 'هذا العضو لديه مفتاح الخزنة؛ استخدم «إزالة من الفريق».',
  too_large: 'البيانات كبيرة جدًا.',
  invalid: 'بعض البيانات غير صحيحة. راجع الحقول وحاول مرة أخرى.',
  not_found: 'العنصر غير موجود (ربما حُذف).',
  gone: 'انتهت صلاحية هذا الجهاز. افتح رابط الدخول مرة أخرى.',
  no_vault_key: 'حسابك لم يحصل على مفتاح الخزنة بعد. اطلب من المدير الموافقة.',
  server_error: 'حدث خطأ في السيرفر. حاول مرة أخرى بعد قليل.',
};

export function errorText(err) {
  if (err instanceof ApiError) {
    if (err.code === 'locked') {
      return `الحساب مقفول مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد ${err.data.minutes || 15} دقيقة، أو اطلب من المدير فك القفل.`;
    }
    return MESSAGES[err.code] || MESSAGES.server_error;
  }
  if (err && err.message === 'backup_password') return 'كلمة سر النسخة الاحتياطية غير صحيحة.';
  if (err && err.message === 'backup_format') return 'هذا الملف ليس نسخة احتياطية صالحة من الخزنة.';
  return 'تعذّر فك التشفير على هذا الجهاز. أعد المحاولة.';
}
