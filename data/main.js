const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT) || 30000;
const ELEMENT_TIMEOUT = parseInt(process.env.ELEMENT_TIMEOUT) || 15000;

const fs = require('fs');
const { chromium } = require('playwright-extra');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const stealth = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');

chromium.use(stealth());

const EMAIL = process.env.OPENAI_EMAIL;
const PASSWORD = process.env.OPENAI_PASSWORD;
const TOTP_SECRET = process.env.OPENAI_TOTP_SECRET;

if (!EMAIL || !PASSWORD || !TOTP_SECRET) {
  console.error('\n❌ CRITICAL: OPENAI_EMAIL, OPENAI_PASSWORD veya OPENAI_TOTP_SECRET çevre değişkenleri eksik! N8n üzerinden hesaba ait bu bilgileri gönderdiğinize emin olun.');
  process.exit(1);
}

// E-posta adresindeki geçersiz karakterleri temizleyerek dosya adı oluştur
const sanitizedEmail = EMAIL.replace(/[^a-zA-Z0-9]/g, '_');
const userDir = path.join(__dirname, 'openai_accounts', sanitizedEmail);

// Kullanıcı için özel klasör oluştur (yoksa)
if (!fs.existsSync(userDir)) {
  fs.mkdirSync(userDir, { recursive: true });
}

// ==========================================
// Log Dosyasına Yazma Özelliği
// ==========================================
const dateStr = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '.');
const LOG_FILE = path.join(userDir, `worker_log-${dateStr}.txt`);

const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, msg + '\n');
};

const originalError = console.error;
console.error = function(...args) {
    originalError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, `ERROR: ${msg}\n`);
};

const COOKIE_FILE = path.join(userDir, `${sanitizedEmail}-session-cookies.json`);

// ==========================================
// TOTP Generator
// ==========================================
function base32Decode(encoded) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of encoded.toUpperCase()) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret) {
  const key = base32Decode(secret);
  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(time, 4);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const hash = hmac.digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24 |
    (hash[offset + 1] & 0xff) << 16 |
    (hash[offset + 2] & 0xff) << 8 |
    (hash[offset + 3] & 0xff)) % 1000000;
  return code.toString().padStart(6, '0');
}

// ==========================================
// FlareSolverr Cloudflare Bypass
// ==========================================
async function bypassCloudflare(url) {
  console.log(`🛡️  FlareSolverr Bypass deneniyor (${url})...`);
  const flaresolverrUrl = process.env.FLARESOLVERR_URL || 'http://n8n-auto-invoice-flaresolverr:8191/v1';
  let resp;
  try {
    resp = await fetch(flaresolverrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 })
    });
  } catch (err) {
    throw new Error(`FlareSolverr ulaşılamıyor: ${err.message}`);
  }

  const data = await resp.json();
  if (data.status !== 'ok') throw new Error('FlareSolverr Hatası: ' + data.message);
  console.log(`   ✅ Bypass OK! (Alınan Cookie Sayısı: ${data.solution.cookies.length})`);

  return {
    cookies: data.solution.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', httpOnly: c.httpOnly || false,
      secure: c.secure || false, sameSite: c.sameSite || 'Lax'
    })),
    userAgent: data.solution.userAgent
  };
}

// ==========================================
// Full (Sıfırdan) Login Akışı
// ==========================================
async function performFullLogin(page, safeScreenshot, userDir) {
  console.log('\n[!] Cookie bulunamadı veya geçersiz. Sıfırdan Login Akışına (Fallback) geçiliyor...');

  // Adım 1-2: login_with -> auth.openai.com
  console.log('📄 Adım 1: chatgpt.com/auth/login_with -> auth.openai.com/log-in');
  await page.goto('https://chatgpt.com/auth/login_with', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-01-login-page.png'));

  // E-posta
  console.log('📧 Adım 2: E-posta giriliyor...');
  const emailInput = page.locator('input[name="email"]').first();
  await emailInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await emailInput.click();
  await page.waitForTimeout(300);
  await emailInput.type(EMAIL, { delay: 60 });
  await safeScreenshot(page, path.join(userDir, 'ss-02-email-entered.png'));

  // Devam et
  console.log('🔘 Adım 3: E-posta onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/log-in/password**', { timeout: ELEMENT_TIMEOUT }).catch(() => { }),
    page.locator('button[name="intent"][value="email"]').click()
  ]);
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-03-email-confirmed.png'));

  // Şifre
  console.log('🔑 Adım 4: Şifre giriliyor...');
  const passInput = page.locator('input[autocomplete="current-password"], input[type="password"]').first();
  await passInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await passInput.click();
  await page.waitForTimeout(300);
  await passInput.type(PASSWORD, { delay: 40 });
  await safeScreenshot(page, path.join(userDir, 'ss-04-password-entered.png'));

  console.log('🔘 Adım 5: Şifre onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/mfa-challenge/**', { timeout: ELEMENT_TIMEOUT }).catch(() => { }),
    page.locator('button[name="intent"][value="validate"]').click()
  ]);
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-05-password-confirmed.png'));

  // OTP
  const otpCode = generateTOTP(TOTP_SECRET);
  console.log(`🔢 Adım 6: OTP Giriliyor (${otpCode})...`);
  const otpInput = page.locator('input[name="code"]').first();
  await otpInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await otpInput.click();
  await page.waitForTimeout(300);
  await otpInput.type(otpCode, { delay: 80 });
  await safeScreenshot(page, path.join(userDir, 'ss-06-otp-entered.png'));

  console.log('🔘 Adım 7: OTP onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/chatgpt.com/**', { timeout: PAGE_TIMEOUT }).catch(() => { }),
    page.locator('button[name="intent"][value="verify"]').click()
  ]);
  await page.waitForTimeout(5000);
  await safeScreenshot(page, path.join(userDir, 'ss-07-otp-confirmed.png'));

  // Manuel Yönlendirme (OTP sonrası chatgpt.com anasayfasına geçiş)
  console.log('🌐 Adım 8: Ana sayfaya yönlendiriliyor...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(5000);
  await safeScreenshot(page, path.join(userDir, 'ss-08-homepage.png'));

  return page.url();
}

// ==========================================
// Ana Yönetici (Main Controller)
// ==========================================
(async () => {
  let browser;
  try {
    // Güvenli ekran görüntüsü fonksiyonu — font timeout hatalarını yakalar, asıl işlemi durdurmaz
    async function safeScreenshot(targetPage, filePath) {
      try {
        await targetPage.screenshot({ path: filePath, fullPage: true, timeout: 10000 });
        console.log(`   📸 SS kaydedildi: ${filePath}`);
      } catch (ssErr) {
        console.log(`   ⚠️ SS alınamadı (${path.basename(filePath)}): ${ssErr.message.substring(0, 80)}`);
      }
    }

    let sessionCookies = [];
    let hasSavedSession = false;

    // 1. Kayıtlı session var mı kontrol et
    if (fs.existsSync(COOKIE_FILE)) {
      try {
        sessionCookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        hasSavedSession = true;
        console.log(`\n💾 Kayıtlı session bulundu (${sessionCookies.length} cookie).`);
      } catch (e) {
        console.warn('⚠️ Kayıtlı cookie dosyası okunamadı (Bozuk JSON). Yok sayılıyor.');
      }
    } else {
      console.log('\nℹ️ Kayıtlı session bulunamadı.');
    }

    // 2. Cloudflare'i FlareSolverr ile aş ve taze cf_clearance cookie'sini al
    const urlToBypass = hasSavedSession ? 'https://chatgpt.com/' : 'https://chatgpt.com/auth/login_with';
    const { cookies: cfCookies, userAgent } = await bypassCloudflare(urlToBypass);

    // Cookie birleştirme
    const finalCookies = [...sessionCookies];
    cfCookies.forEach(cfCookie => {
      const idx = finalCookies.findIndex(c => c.name === cfCookie.name && c.domain === cfCookie.domain);
      if (idx !== -1) finalCookies[idx] = cfCookie;
      else finalCookies.push(cfCookie);
    });

    // 3. Playwright Başlat
    console.log('\n🚀 Stealth Playwright başlatılıyor...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 800 },
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      acceptDownloads: true
    });

    // Sadece url barındırmayan temiz formattaki cookieleri yükle
    const cleanCookies = finalCookies.map(c => {
      const { url, ...cleanC } = c;
      return cleanC;
    });

    await context.addCookies(cleanCookies);
    const page = await context.newPage();

    let finalUrl = '';
    let success = false;

    // 4. Eğer session varsa Cookie ile Giriş (Bypass) dene
    if (hasSavedSession) {
      console.log('🌐 Cookie ile ChatGPT anasayfasına gidiliyor...');
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(5000);

      finalUrl = page.url();
      success = finalUrl === 'https://chatgpt.com/' || finalUrl.includes('chatgpt.com/c/');

      if (success) {
        console.log('\n✅ COOKIE İLE GİRİŞ BAŞARILI! (Fallback kullanılmadı)');
      } else {
        console.log('\n❌ Cookie geçersiz çıkmış veya süre dolmuş. (Fallback devreye giriyor)');
      }
    }

    // 5. Fallback: Eğer Cookie ile giriş denenmediyse VEYA Cookie geçersiz çıktıysa sıfırdan Full Login yap
    if (!success) {
      finalUrl = await performFullLogin(page, safeScreenshot, userDir);
      success = finalUrl === 'https://chatgpt.com/' || finalUrl.includes('chatgpt.com/c/');

      if (success) {
        console.log('\n✅ SIFIRDAN GİRİŞ (FALLBACK) BAŞARILI!');
      } else {
        console.log('\n❌ Sıfırdan giriş denemesi de başarısız oldu.');
      }
    }

    // 6. Başarılı olduysa yeni cookie'leri kaydet (Bir sonraki sefere lazım olacak)
    if (success) {
      const allCookies = await context.cookies();
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(allCookies, null, 2));
      console.log(`   💾 Güncel Cookie'ler kaydedildi: ${COOKIE_FILE}`);

      await safeScreenshot(page, path.join(userDir, 'ss-09-login-success.png'));

      // === FATURA INDIRME SIMULASYONU ===
      console.log('\n⚙️ Adım 13: Hesap Ayarları sayfasına gidiliyor (/#settings/Account)...');
      await page.goto('https://chatgpt.com/#settings/Account', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(4000);

      console.log('   URL:', page.url());
      await safeScreenshot(page, path.join(userDir, 'ss-10-settings.png'));

      console.log('\n💳 Adım 14: Ödeme (Payment) bölümündeki "Yönet" butonuna tıklanıyor...');
      // Üstteki abonelik Manage butonunu atlayıp, alttaki ödeme Manage butonunu (aria-label ile) buluyoruz:
      const manageBtn = page.locator('button[aria-label="Ödemeyi yönet"], button[aria-label="Manage payment"], button[aria-label="Manage billing"]').first();

      try {
        await manageBtn.scrollIntoViewIfNeeded();
        await manageBtn.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT });

        // Ödemeyi yönet genelde Stripe portalını yeni sekmede açar
        // Yeni sekmeyi yakalayıp Stripe URL'sini alıyoruz
        const pagePromise = context.waitForEvent('page', { timeout: ELEMENT_TIMEOUT }).catch(() => null);
        await manageBtn.click();

        const dirtyStripePage = await pagePromise;
        let stripeUrl = '';

        if (dirtyStripePage) {
          // Yeni sekme açıldı, URL'yi al ve kapat
          await dirtyStripePage.waitForLoadState('domcontentloaded').catch(() => { });
          stripeUrl = dirtyStripePage.url();
          await dirtyStripePage.close();
          console.log(`   🔗 Stripe URL yakalandı: ${stripeUrl}`);
        } else {
          // Aynı sekmede açıldıysa URL'yi al
          stripeUrl = page.url();
          console.log(`   🔗 Stripe URL (aynı sekme): ${stripeUrl}`);
        }

        // ====================================================
        // 🧹 TEMİZ BROWSER CONTEXT - FlareSolverr kalıntısız
        // ====================================================
        console.log('\n🧹 Stripe için tertemiz browser context açılıyor (FlareSolverr izolasyonu)...');
        const stripeContext = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          locale: 'tr-TR',
          timezoneId: 'Europe/Istanbul',
          acceptDownloads: true
          // userAgent belirtmiyoruz = varsayılan Chromium UA kullanılacak
          // FlareSolverr cookie yok, manipülasyon yok
        });

        const stripePage = await stripeContext.newPage();

        // Stripe portalına temiz context ile git
        console.log('   🌐 Stripe portalına temiz context ile gidiliyor...');
        await stripePage.goto(stripeUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await stripePage.waitForTimeout(4000);

        const targetSelection = process.env.OPENAI_TARGET_INVOICE || 'last';
        console.log(`\n📄 Adım 15: Fatura bulunuyor... (Seçilen Hedef: ${targetSelection})`);

        await safeScreenshot(stripePage, path.join(userDir, 'ss-11-stripe-portal.png'));

        const invoiceLinks = stripePage.locator('a[data-testid="hip-link"], a[href*="invoice.stripe.com"]');
        await invoiceLinks.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });

        let targetLink;
        if (targetSelection === 'previous') {
          console.log('   Hedef "previous" (sondan bir önceki) fatura seçildi.');
          targetLink = invoiceLinks.nth(1);
        } else {
          console.log('   Hedef "last" (en güncel) fatura seçildi.');
          targetLink = invoiceLinks.first();
        }

        // Fatura tarihini Stripe arayüzünden kazıyıp alalım
        const invoiceDateText = await targetLink.locator('span').first().textContent().catch(() => '');
        console.log(`   📅 Fatura Tarihi Okundu: ${invoiceDateText.trim()}`);

        const trMonths = {
          'ocak': 'january', 'oca': 'jan',
          'şubat': 'february', 'subat': 'february', 'şub': 'feb', 'sub': 'feb',
          'mart': 'march', 'mar': 'mar',
          'nisan': 'april', 'nis': 'apr',
          'mayıs': 'may', 'mayis': 'may',
          'haziran': 'june', 'haz': 'jun',
          'temmuz': 'july', 'tem': 'jul',
          'ağustos': 'august', 'agustos': 'august', 'ağu': 'aug', 'agu': 'aug',
          'eylül': 'september', 'eylul': 'september', 'eyl': 'sep',
          'ekim': 'october', 'eki': 'oct',
          'kasım': 'november', 'kasim': 'november', 'kas': 'nov',
          'aralık': 'december', 'aralik': 'december', 'ara': 'dec'
        };

        let cleanDate = invoiceDateText.toLowerCase().replace(/,/g, '');
        for (const [tr, en] of Object.entries(trMonths)) {
          if (cleanDate.includes(tr)) {
            cleanDate = cleanDate.replace(tr, en);
            break;
          }
        }

        // Parselama başarısız olursa bugünkü tarihi dönecek
        const parsedNodeDate = new Date(cleanDate);
        let formattedDate = `${String(new Date().getDate()).padStart(2, '0')}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getFullYear())}`;

        if (!isNaN(parsedNodeDate.getTime())) {
          const dd = String(parsedNodeDate.getDate()).padStart(2, '0');
          const mm = String(parsedNodeDate.getMonth() + 1).padStart(2, '0');
          const yyyy = String(parsedNodeDate.getFullYear());
          formattedDate = `${dd}-${mm}-${yyyy}`;
        }

        console.log(`   🗓️ Dosya adı için çevrilen tarih: ${formattedDate}`);

        // Fatura linkine tıkla - temiz context'te yeni sekme açılacak
        console.log('   🔗 Fatura linkine tıklanıyor...');
        const invoiceUrl = await targetLink.getAttribute('href');

        let invoicePage;
        if (invoiceUrl) {
          // Doğrudan URL ile git (daha güvenilir)
          invoicePage = await stripeContext.newPage();
          await invoicePage.goto(invoiceUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        } else {
          // Tıklayarak aç
          const [newInvPage] = await Promise.all([
            stripeContext.waitForEvent('page', { timeout: ELEMENT_TIMEOUT }),
            targetLink.click()
          ]);
          invoicePage = newInvPage;
          await invoicePage.waitForLoadState('domcontentloaded');
        }

        console.log('   ✅ Fatura sayfası açıldı:', invoicePage.url());
        await invoicePage.waitForTimeout(4000);
        await safeScreenshot(invoicePage, path.join(userDir, 'ss-12-download-page.png'));

        const safeEmail = EMAIL.replace(/[^a-zA-Z0-9]/g, '_');

        // --- FATURA İNDİRME ---
        console.log('\n📥 Adım 16: Fatura (Invoice) PDF olarak indiriliyor...');
        const downloadInvoiceBtn = invoicePage.locator('button:has-text("Faturayı indir"), button:has-text("Download invoice")').first();
        await downloadInvoiceBtn.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });

        const [invoiceDownload] = await Promise.all([
          invoicePage.waitForEvent('download', { timeout: PAGE_TIMEOUT }),
          downloadInvoiceBtn.click()
        ]);

        const invoiceFileName = `${safeEmail}_fatura_${formattedDate}.pdf`;
        await invoiceDownload.saveAs(path.join(userDir, invoiceFileName));
        console.log(`   ✅ Fatura başarıyla indirildi: /data/openai_accounts/${sanitizedEmail}/${invoiceFileName}`);

        // --- MAKBUZ İNDİRME ---
        console.log('\n📥 Adım 17: Makbuz (Receipt) PDF olarak indiriliyor...');
        const downloadReceiptBtn = invoicePage.locator('[data-testid="download-invoice-receipt-pdf-button"]').first();
        await downloadReceiptBtn.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });

        const [receiptDownload] = await Promise.all([
          invoicePage.waitForEvent('download', { timeout: PAGE_TIMEOUT }),
          downloadReceiptBtn.click()
        ]);

        const receiptFileName = `${safeEmail}_makbuz_${formattedDate}.pdf`;
        await receiptDownload.saveAs(path.join(userDir, receiptFileName));
        console.log(`   ✅ Makbuz başarıyla indirildi: /data/openai_accounts/${sanitizedEmail}/${receiptFileName}`);

        // Temiz context'i kapat
        await stripeContext.close();
        console.log('   🧹 Temiz Stripe context kapatıldı.');

        console.log('\n🎉 TÜM İŞLEMLER BAŞARIYLA TAMAMLANDI!');

      } catch (e) {
        console.log('   ⚠️ Fatura yönetimi / indirme sürecinde hata:', e.message);
        const errPage = context.pages()[context.pages().length - 1];
        if (errPage) await safeScreenshot(errPage, path.join(userDir, `ss-error-billing-${Date.now()}.png`));
      }

    } else {
      await safeScreenshot(page, path.join(userDir, 'ss-final-error.png'));
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Genel Hata Yakalandı:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
