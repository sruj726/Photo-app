/* Loaded only inside the Capacitor shell (add to the WKWebView via a script injection or ship it in www/).
 * Adapts the Capacitor plugin to the window.TripLinkNative contract app.js expects. */
(function () {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
  const plugin = window.Capacitor.Plugins && window.Capacitor.Plugins.TripLinkNative;
  if (!plugin) return;
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    if (!blob) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  window.TripLinkNative = {
    async enqueueUpload({ queueId, url, token, blob, thumb, original, meta }) {
      return plugin.enqueueUpload({
        queueId, url, token, mime: blob.type || 'application/octet-stream', meta: meta || {},
        blobBase64: await toBase64(blob), thumbBase64: await toBase64(thumb),
        originalBase64: await toBase64(original), originalMime: original ? original.type : undefined,
      });
    },
  };
  plugin.addListener('uploadDone', (d) => window.dispatchEvent(new CustomEvent('triplink:native-upload-done', { detail: d })));
  plugin.addListener('uploadFailed', (d) => window.dispatchEvent(new CustomEvent('triplink:native-upload-failed', { detail: d })));
})();
