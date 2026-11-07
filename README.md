# Pagekeep

Scan paper with your phone camera and keep it as clean, searchable PDFs. Works offline; scans never leave your device.

Android app (Capacitor) and Windows app (Electron) share one plain-JavaScript UI in `app/`.

## Features

- **Live page detection** in the camera, with auto capture when the page is held steady, torch, and Single / Batch / ID card modes
- **Corner adjust** with edge handles and a magnifier; "Whole photo" and re-detect
- **Perspective straightening** (own homography + bilinear warp, `app/js/imgproc.js`)
- **Filters**: Original, Auto, Vivid, Clean, Grey, B & W, Ink saver, plus brightness and contrast
- **Signatures**: draw once, place and resize on any page
- **Offline text recognition** (Tesseract, English model bundled) with copy and share
- **PDF export**: A4 / Letter / Legal / Fit photo, three quality levels, optional **searchable PDF** (invisible text layer)
- **Library**: search by name or by text inside scans, sort, rename, reorder pages by drag, share as PDF / images / text

## Develop

```
npm install
npm start          # Windows/desktop app
npm test           # unit tests (edge detection, warp, filters, PDF writer)
cd mobile && npm install && npm run sync   # Android project in mobile/android
```

CI (`.github/workflows/build.yml`) builds the Windows installer and a debug APK on every push.

## Licences

Text recognition uses [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) and the Tesseract English model, vendored in `app/vendor/tesseract`.
