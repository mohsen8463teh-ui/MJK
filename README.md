# CryptoPulse Android

این پوشه نسخه Android پروژه CryptoPulse است. رابط فعلی پروژه داخل APK قرار می‌گیرد و Backend از طریق URL قابل تنظیم استفاده می‌شود.

## معماری
- APK: رابط کاربری و WebView
- Backend: همان FastAPI پروژه اصلی
- Background check: Android WorkManager هر حداقل ۱۵ دقیقه یک‌بار آخرین سیگنال را بررسی می‌کند و در صورت جدید بودن اعلان محلی می‌فرستد.

## نکته
برای استفاده واقعی باید Backend روی یک آدرس قابل دسترس از گوشی اجرا شود و مقدار `cryptopulse-api-base` در localStorage تنظیم شود. در نسخه بعدی می‌توانیم صفحه تنظیم آدرس سرور را داخل اپ اضافه کنیم.

این پروژه نیاز به Android SDK/Gradle برای Build نهایی APK دارد.


## Build on GitHub
1. Upload the `android` folder to a GitHub repository (keep `.github/workflows/build-apk.yml`).
2. Open **Actions** → **Build CryptoPulse APK** → **Run workflow**.
3. After it finishes, open the workflow run and download the `CryptoPulse-release-apk` artifact.

The app asks for the public HTTPS URL of the CryptoPulse backend on first launch. The backend must be reachable from the internet for background checks while the app is closed.
