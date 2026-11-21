"""Browser end-to-end test: drives the real UI in headless Chrome against a local server.
Checks the full first-run → add → search → reveal → invite → approve → member-login flow,
and fails on any console error (CSP / Trusted Types violations included).

  python3 test/e2e_browser.py <base_url> <setup_token> <screenshot_dir>
"""
import base64
import hashlib
import hmac
import struct
import sys
import time
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright, expect

BASE, SETUP_TOKEN, SHOTS = sys.argv[1], sys.argv[2], sys.argv[3]
ADMIN_PW = 'Correct-Horse-Battery-77!'
MEMBER_PW = 'Member-Strong-Pass-2026'


class Auth:
    def __init__(self, secret):
        s = secret.replace(' ', '')
        self.key = base64.b32decode(s + '=' * ((8 - len(s) % 8) % 8))
        self.last = 0

    def code(self):
        now = int(time.time() // 30)
        step = max(self.last + 1, now - 1)
        while step > now + 1:
            time.sleep(1)
            now = int(time.time() // 30)
        self.last = step
        h = hmac.new(self.key, struct.pack('>Q', step), hashlib.sha1).digest()
        o = h[-1] & 0x0F
        return '%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


errors = []


def watch(page, who):
    page.on('console', lambda m: errors.append(f'[{who}] console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'[{who}] pageerror: {e}'))


def shot(page, name, full=True):
    page.screenshot(path=f'{SHOTS}/{name}.png', full_page=full)


def add_entry(page, client, platform, label, username, password=None, notes='', tech=None):
    page.get_by_role('button', name='إضافة حساب', exact=True).click()
    dlg = page.locator('dialog[open]')
    dlg.get_by_label('العميل').fill(client)
    dlg.get_by_label('المنصة', exact=True).select_option(platform)
    dlg.get_by_label('وصف الحساب (اختياري)').fill(label)
    dlg.get_by_label('اسم المستخدم أو الإيميل أو رقم الموبايل').fill(username)
    if password:
        dlg.get_by_label('كلمة السر', exact=True).fill(password)
    else:
        dlg.get_by_role('button', name='توليد كلمة سر قوية').click()
    if notes:
        dlg.get_by_label('ملاحظات سرية (اختياري)').fill(notes)
    if tech:
        details = dlg.locator('details.tech')
        if details.get_attribute('open') is None:
            details.locator('summary').click()
        dlg.get_by_label('مكان الاستضافة').fill(tech['hosting'])
        dlg.get_by_label('مكان قاعدة البيانات').fill(tech['db'])
        dlg.get_by_label('رابط قاعدة البيانات (سري ومشفر)').fill(tech['dbUrl'])
        dlg.get_by_label('تاريخ التجديد أو الانتهاء').fill(tech['renewAt'])
    dlg.get_by_role('button', name='حفظ الحساب').click()
    expect(page.locator('dialog[open]')).to_have_count(0, timeout=15000)


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])

    # ---------- admin: first-run setup ----------
    ctx = browser.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG', timezone_id='Africa/Cairo')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    probe = ctx.new_page()
    resp = probe.goto(f'{BASE}/')
    assert resp.status == 404, 'stranger must see 404'
    assert probe.locator('body').inner_text().strip() == 'Not Found'
    probe.close()
    page = ctx.new_page()
    watch(page, 'admin')
    page.goto(f'{BASE}/setup/{SETUP_TOKEN}')
    expect(page.get_by_role('heading', name='تجهيز الخزنة لأول مرة')).to_be_visible()
    shot(page, '01-setup')
    page.get_by_label('اسمك').fill('أحمد حمودي')
    page.get_by_label('اسم المستخدم').fill('owner')
    page.get_by_label('كلمة السر الرئيسية', exact=True).fill(ADMIN_PW)
    page.get_by_label('أعد كتابة كلمة السر الرئيسية').fill(ADMIN_PW)
    page.get_by_role('button', name='متابعة').click()
    expect(page.locator('.form-error')).to_contain_text('أكّد')  # checkbox is required
    page.locator('.check input').check()
    page.get_by_role('button', name='متابعة').click()
    expect(page.get_by_role('heading', name='فعّل التحقق بخطوتين')).to_be_visible(timeout=30000)
    page.locator('.manual-key summary').click()
    secret = page.locator('.manual-key code').inner_text()
    admin_auth = Auth(secret)
    shot(page, '02-totp')
    page.get_by_label('الرمز من التطبيق').fill(admin_auth.code())
    page.get_by_role('button', name='تفعيل وفتح الخزنة').click()
    expect(page.get_by_role('heading', name='الخزنة فارغة')).to_be_visible(timeout=30000)
    shot(page, '03-empty-vault')

    # ---------- add credentials ----------
    add_entry(page, 'Star Style - ستار ستايل', 'instagram', '@starstyle.eg', 'starstyle.eg', 'Ig-Pass-123!', 'Backup codes: 1111 2222 3333\nالرقم المربوط: 01000000000')
    add_entry(page, 'Star Style - ستار ستايل', 'facebook', 'صفحة Star Style', 'ads@starstyle.com')
    add_entry(page, 'Star Style - ستار ستايل', 'meta_ads', 'حساب الإعلانات الرئيسي', 'ads@starstyle.com')
    add_entry(page, 'Nile Foods', 'tiktok', '', 'nilefoods.official')
    add_entry(page, 'Nile Foods', 'instagram', '@nilefoods', 'nilefoods')
    add_entry(page, 'مطعم الكورنيش', 'google', 'Gmail', 'corniche.rest@gmail.com')
    renew_at = time.strftime('%Y-%m-%d', time.localtime(time.time() + 12 * 86400))
    add_entry(page, 'Cairo Gym', 'website', 'لوحة تحكم الموقع', 'admin',
              tech={'hosting': 'Hostinger', 'db': 'Neon', 'dbUrl': 'postgresql://gym:S3cret@ep-x.neon.tech/gym', 'renewAt': renew_at})
    gym = page.locator('.row').filter(has_text='لوحة تحكم الموقع')
    expect(gym.locator('.row-tags')).to_contain_text('Hostinger')
    expect(gym.locator('.row-tags')).to_contain_text('Neon')
    expect(gym.locator('.row-tags')).to_contain_text('12')
    gym.get_by_role('button', name='إظهار').click()
    expect(gym.locator('.row-extra')).to_contain_text('postgresql://gym:S3cret@ep-x.neon.tech/gym')
    shot(page, '04b-program-details')
    gym.get_by_role('button', name='إخفاء').click()
    page.get_by_role('button', name='كل العملاء').click()
    expect(page.locator('.box')).to_have_count(4)
    expect(page.locator('.banner').filter(has_text='خلال 30 يومًا')).to_be_visible(timeout=15000)
    shot(page, '04-client-wall')

    # ---------- search by client name (Arabic and English, typos in hamza) ----------
    search = page.get_by_role('searchbox', name='ابحث باسم العميل')
    search.fill('ستار')
    expect(page.locator('.client')).to_have_count(1)
    expect(page.locator('.client .row')).to_have_count(3)
    search.fill('star style')
    expect(page.locator('.client .row')).to_have_count(3)
    search.fill('انستجرام')
    expect(page.locator('.client')).to_have_count(2)
    search.fill('إنستجرام')
    expect(page.locator('.client')).to_have_count(2)
    search.fill('zzz-not-there')
    expect(page.get_by_role('heading', name='لا يوجد عميل باسم «zzz-not-there»')).to_be_visible()
    search.fill('star')
    row = page.locator('.row').filter(has_text='@starstyle.eg')
    row.get_by_role('button', name='إظهار').click()
    expect(row.locator('.secret')).to_have_text('Ig-Pass-123!')
    expect(row.locator('.note-text')).to_contain_text('Backup codes')
    shot(page, '05-search-reveal')
    row.get_by_role('button', name='نسخ كلمة السر').click()
    expect(page.locator('.toast').filter(has_text='تم نسخ كلمة السر')).to_be_visible()
    clip = page.evaluate('navigator.clipboard.readText()')
    assert clip == 'Ig-Pass-123!', clip

    # edit → password history
    row.get_by_role('button', name='تعديل').click()
    dlg = page.locator('dialog[open]')
    pw = dlg.get_by_label('كلمة السر', exact=True)
    expect(pw).to_have_value('Ig-Pass-123!')
    shot(page, '06-edit-dialog', full=False)
    pw.fill('Ig-NEW-456!')
    dlg.get_by_role('button', name='حفظ التعديلات').click()
    expect(page.locator('dialog[open]')).to_have_count(0)
    row = page.locator('.row').filter(has_text='@starstyle.eg')
    row.get_by_role('button', name='إظهار').click()
    expect(row.locator('.secret')).to_have_text('Ig-NEW-456!')
    expect(row.locator('.history')).to_contain_text('Ig-Pass-123!')

    # ---------- invite a member ----------
    page.locator('details.menu > summary').click()
    page.get_by_role('button', name='الإدارة').click()
    expect(page.get_by_role('heading', name='دعوة عضو جديد')).to_be_visible()
    page.get_by_label('الاسم', exact=True).fill('سارة')
    page.get_by_label('اسم المستخدم').fill('sara')
    page.get_by_role('button', name='إنشاء رابط الدعوة').click()
    link = page.locator('.invite-result input').input_value()
    assert '#invite=' in link, link
    shot(page, '07-admin-team')

    # ---------- member registers on her own browser ----------
    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, locale='ar-EG', is_mobile=True, has_touch=True)
    mpage = mctx.new_page()
    watch(mpage, 'member')
    mpage.goto(link)
    expect(mpage.get_by_role('heading', name='انضم إلى خزنة الفريق')).to_be_visible()
    mpage.get_by_label('كلمة السر الرئيسية', exact=True).fill(MEMBER_PW)
    mpage.get_by_label('أعد كتابة كلمة السر الرئيسية').fill(MEMBER_PW)
    mpage.locator('.check input').check()
    shot(mpage, '08-member-register')
    mpage.get_by_role('button', name='متابعة').click()
    expect(mpage.get_by_role('heading', name='فعّل التحقق بخطوتين')).to_be_visible(timeout=30000)
    mpage.locator('.manual-key summary').click()
    member_auth = Auth(mpage.locator('.manual-key code').inner_text())
    mpage.get_by_label('الرمز من التطبيق').fill(member_auth.code())
    mpage.get_by_role('button', name='تفعيل وإنهاء التسجيل').click()
    expect(mpage.get_by_role('heading', name='حسابك جاهز وبانتظار موافقة المدير')).to_be_visible()
    member_fp = mpage.locator('.fingerprint').inner_text()
    shot(mpage, '09-member-pending')

    # ---------- admin approves after comparing fingerprints ----------
    page.get_by_role('tab', name='الفريق').click()
    pending = page.locator('.pending')
    expect(pending).to_have_count(1)
    assert pending.locator('.fingerprint').inner_text() == member_fp, 'fingerprints must match'
    shot(page, '10-admin-pending')
    pending.get_by_role('button', name='موافقة ومنحه مفتاح الخزنة').click()
    expect(page.locator('.pending')).to_have_count(0)

    # ---------- member logs in and finds the client ----------
    mpage.get_by_role('button', name='تسجيل الدخول بعد الموافقة').click()
    mpage.get_by_label('كلمة السر الرئيسية').fill(MEMBER_PW)
    mpage.get_by_label('رمز التحقق').fill(member_auth.code())
    mpage.get_by_role('button', name='افتح الخزنة').click()
    expect(mpage.locator('.box')).to_have_count(4, timeout=30000)
    shot(mpage, '11-member-wall-mobile')
    mpage.get_by_role('searchbox', name='ابحث باسم العميل').fill('nile')
    expect(mpage.locator('.client .row')).to_have_count(2)
    shot(mpage, '12-member-search-mobile')
    expect(mpage.locator('details.menu').get_by_role('button', name='الإدارة')).to_have_count(0)

    # ---------- the member's second device must be approved ----------
    m2 = browser.new_context(viewport={'width': 1280, 'height': 800}, locale='ar-EG')
    m2page = m2.new_page()
    watch(m2page, 'member-laptop')
    gate = link.split('#')[0]
    m2page.goto(gate)
    m2page.get_by_label('اسم المستخدم').fill('sara')
    m2page.get_by_label('كلمة السر الرئيسية').fill(MEMBER_PW)
    m2page.get_by_label('رمز التحقق').fill(member_auth.code())
    m2page.get_by_role('button', name='افتح الخزنة').click()
    expect(m2page.get_by_role('heading', name='هذا جهاز جديد')).to_be_visible(timeout=30000)
    shot(m2page, '13-device-pending')
    page.get_by_role('tab', name='الأجهزة').click()
    expect(page.get_by_role('button', name='موافقة')).to_have_count(1)
    shot(page, '14-admin-devices')
    page.get_by_role('button', name='موافقة').click()
    expect(page.get_by_role('button', name='موافقة')).to_have_count(0)

    # ---------- audit log ----------
    page.get_by_role('tab', name='سجل النشاط').click()
    expect(page.locator('.log-item').first).to_be_visible()
    expect(page.locator('.log')).to_contain_text('نسخ كلمة سر')
    expect(page.locator('.log')).to_contain_text('طلب دخول من جهاز جديد')
    shot(page, '15-admin-audit')

    # ---------- subscriptions & invoices: alerts, Hostinger, Render, monthly report ----------
    page.locator('.topbar .bell').click()
    expect(page.get_by_role('tab', name='التنبيهات')).to_have_attribute('aria-selected', 'true')
    hub = page.locator('.admin-panel')
    for name in ['old-client.com', 'star-style-db', 'starstyle.com (.COM Domain)', 'starstyle.com (Business Web Hosting)', 'Cairo Gym',
                 'nilefoods.de (.DE Domain)', 'Visa visa_ending_4242', 'starstyle.com (Starter Business Email)', 'nilefoods.net (Premium Business Email)']:
        expect(hub).to_contain_text(name, timeout=20000)
    expect(hub).not_to_contain_text('nilefoods.net (.net Domain)')
    # A domain ending at 23:59:59 UTC in 9 days reads "in 9 days" in Cairo too, with its name in letters.
    expect(hub.locator('.alert-item').filter(has_text='bücher.de')).to_contain_text('بعد 9 أيام')
    expect(hub.get_by_role('heading', name='خلال شهرين (2)')).to_be_visible()
    bell = page.locator('.topbar [data-bell]')
    expect(bell).to_be_visible()
    unread_before = int(bell.inner_text())
    assert unread_before >= 10, unread_before
    hub.locator('.alert-item').filter(has_text='star-style-db').get_by_role('button', name='تعليم كمقروء').click()
    expect(bell).to_have_text(str(unread_before - 1))
    shot(page, '15b-alerts')
    page.get_by_role('button', name='تعليم الكل كمقروء').click()
    expect(bell).to_be_hidden()

    page.get_by_role('tab', name='Hostinger').click()
    for text in ['WordPress', 'Website Builder', 'موقوف', 'Starter Business Email', 'visa_ending_4242', 'bücher.de', 'الخطة: Business']:
        expect(hub).to_contain_text(text, timeout=20000)
    row = hub.locator('li.person').filter(has_text='starstyle.com (Business Web Hosting)')
    row.get_by_role('button', name='ربط بعميل').click()
    dlg = page.locator('dialog[open]')
    dlg.get_by_label('العميل', exact=True).fill('Star Style - ستار ستايل')
    dlg.get_by_label('المطلوب من العميل').fill('250')
    dlg.get_by_role('button', name='حفظ').click()
    expect(page.locator('.toast').filter(has_text='تم حفظ العميل')).to_be_visible()
    expect(hub.locator('li.person').filter(has_text='starstyle.com (Business Web Hosting)')).to_contain_text('العميل: Star Style - ستار ستايل')
    shot(page, '15c-hostinger')

    page.get_by_role('tab', name='Render').click()
    for text in ['nile-api', 'www.starstyle.com', 'star-cache', 'GoTrend', 'موقوفة']:
        expect(hub).to_contain_text(text, timeout=20000)
    # standard $25 + basic_256mb $6 + Key Value starter $10; the suspended service is not counted
    expect(hub.locator('.stat').filter(has_text='التكلفة الشهرية التقديرية')).to_contain_text('41')
    shot(page, '15d-render')

    page.get_by_role('tab', name='التقرير الشهري').click()
    expect(hub.get_by_role('heading', name='حسب العميل')).to_be_visible(timeout=20000)
    expect(hub).to_contain_text('nile-api')  # Render costs every month
    # go to the month in which the hosting renewal (in 20 days) falls
    now = datetime.now(timezone.utc)
    target = now + timedelta(days=20)
    for _ in range((target.year - now.year) * 12 + target.month - now.month):
        page.get_by_role('button', name='الشهر التالي').click()
    line = hub.locator('tr').filter(has_text='starstyle.com (Business Web Hosting)')
    expect(line).to_contain_text('Star Style - ستار ستايل')
    expect(line).to_contain_text('250')
    expect(line).to_contain_text('يحتاج تجديد يدوي')
    expect(hub.locator('table').first.locator('tr').filter(has_text='Star Style - ستار ستايل')).to_contain_text('250')
    page.get_by_role('button', name='إضافة تكلفة أخرى').click()
    dlg = page.locator('dialog[open]')
    dlg.get_by_label('البند').fill('Google Workspace')
    dlg.get_by_label('الشركة').fill('Google')
    dlg.get_by_label('العميل', exact=True).fill('Nile Foods')
    dlg.get_by_label('التكلفة علينا').fill('6')
    dlg.get_by_label('المطلوب من العميل').fill('15')
    dlg.get_by_label('أول موعد').fill(f'{target.year}-{target.month:02d}-15')
    dlg.get_by_role('button', name='حفظ').click()
    expect(page.locator('.toast').filter(has_text='تم حفظ البند')).to_be_visible()
    expect(hub.locator('tr').filter(has_text='Google Workspace')).to_contain_text('Nile Foods')
    with page.expect_download() as dl:
        page.get_by_role('button', name='تنزيل Excel (CSV)').click()
    csv_text = open(dl.value.path(), encoding='utf-8-sig').read()
    assert 'starstyle.com (Business Web Hosting)' in csv_text and 'Star Style - ستار ستايل' in csv_text and ',250,' in csv_text, csv_text[:400]
    assert 'Google Workspace,Google,Nile Foods,6,USD,15,EUR' in csv_text, csv_text
    shot(page, '15e-report')
    page.set_viewport_size({'width': 390, 'height': 844})
    shot(page, '15f-report-phone')
    page.get_by_role('tab', name='التنبيهات').click()
    expect(page.locator('.alert-item').first).to_be_visible(timeout=20000)
    shot(page, '15g-alerts-phone')
    page.set_viewport_size({'width': 1366, 'height': 900})

    page.locator('details.menu > summary').click()
    page.get_by_role('button', name='الإدارة').click()
    page.get_by_role('tab', name='النسخ الاحتياطي').click()
    page.get_by_label('كلمة سر النسخة الاحتياطية', exact=True).first.fill('Backup-Pass-2026-OK!')
    page.get_by_label('أعد كتابتها').fill('Backup-Pass-2026-OK!')
    with page.expect_download() as dl:
        page.get_by_role('button', name='تنزيل نسخة احتياطية مشفرة').click()
    backup_path = dl.value.path()
    backup_text = open(backup_path, encoding='utf-8').read()
    assert '"team-vault-backup"' in backup_text and 'Star' not in backup_text and 'Ig-NEW' not in backup_text
    page.locator('input[type=file]').set_input_files(backup_path)
    page.get_by_label('كلمة سر النسخة الاحتياطية').nth(1).fill('Backup-Pass-2026-OK!')
    page.get_by_role('button', name='استرجاع الحسابات من الملف').click()
    expect(page.locator('.toast').filter(has_text='مكرر')).to_be_visible(timeout=30000)
    shot(page, '16-admin-backup')

    # ---------- removing a member rotates the vault key ----------
    page.get_by_role('tab', name='الفريق').click()
    page.locator('.person').filter(has_text='sara').get_by_role('button', name='إزالة من الفريق').click()
    page.locator('dialog[open]').get_by_role('button', name='إزالة وتغيير المفتاح').click()
    expect(page.locator('.toast').filter(has_text='تمت إزالة')).to_be_visible(timeout=30000)
    expect(page.locator('.person').filter(has_text='sara')).to_have_count(0)
    mpage.reload()
    expect(mpage.get_by_role('button', name='افتح الخزنة')).to_be_visible()
    expect(mpage.get_by_label('رمز التحقق')).to_be_visible()  # back to full login: the account is gone
    page.get_by_role('tab', name='رابط الدخول').click()
    shot(page, '17-admin-gate')
    # the billing notes moved to the new vault key with everything else
    page.locator('.topbar .bell').click()
    page.get_by_role('tab', name='التقرير الشهري').click()
    expect(page.locator('.admin-panel')).to_contain_text('التقرير الشهري', timeout=20000)
    page.locator('details.menu > summary').click()
    page.locator('.menu-pop').get_by_role('button', name='الاشتراكات والفواتير').click()
    page.get_by_role('tab', name='Hostinger').click()
    expect(page.locator('li.person').filter(has_text='starstyle.com (Business Web Hosting)')).to_contain_text('العميل: Star Style - ستار ستايل', timeout=20000)

    # ---------- lock and unlock ----------
    page.get_by_role('button', name='رجوع للخزنة').click()
    page.get_by_role('button', name='قفل الخزنة الآن').click()
    expect(page.get_by_role('heading', name='أهلًا أحمد حمودي')).to_be_visible()
    shot(page, '18-unlock')
    page.get_by_label('كلمة السر الرئيسية').fill('wrong-password-123')
    page.get_by_role('button', name='افتح الخزنة').click()
    expect(page.locator('.form-error')).to_contain_text('غير صحيحة', timeout=30000)
    page.get_by_label('كلمة السر الرئيسية').fill(ADMIN_PW)
    page.get_by_role('button', name='افتح الخزنة').click()
    expect(page.locator('.box')).to_have_count(4, timeout=30000)

    # reload: keys are gone from memory, so the vault asks for the master password again
    page.reload()
    expect(page.get_by_role('heading', name='أهلًا أحمد حمودي')).to_be_visible()

    # login screen look
    lctx = browser.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG')
    lpage = lctx.new_page()
    watch(lpage, 'login')
    lpage.goto(gate)
    expect(lpage.get_by_role('button', name='افتح الخزنة')).to_be_visible()
    shot(lpage, '19-login')

    browser.close()

# The deliberate wrong-password unlock answers 401, which Chrome logs as a failed resource.
errors = [e for e in errors if 'status of 401' not in e]
if errors:
    print('BROWSER ERRORS:')
    for e in errors:
        print('  ', e)
    sys.exit(1)
print('E2E OK')
