export const DRIVE_ORIGIN = 'https://api-drive.mypikpak.com/*';

// Invoke directly inside the connect click, before waiting for locks/network calls.
// Requesting an already granted declared host permission does not show a new prompt.
export function requestDriveAccess(extension = globalThis.chrome) {
  if (!extension?.permissions?.request) return Promise.reject(new Error('EXTENSION_CONTEXT：请从 Chrome 扩展图标打开工具页。'));
  return new Promise((resolve, reject) => {
    extension.permissions.request({ origins: [DRIVE_ORIGIN] }, granted => {
      if (extension.runtime?.lastError) {
        reject(new Error('HOST_PERMISSION：无法申请网盘访问权限，请检查扩展的“网站访问权限”。'));
      } else if (!granted) {
        reject(new Error('HOST_PERMISSION：尚未允许此扩展访问 api-drive.mypikpak.com，请允许后重试。'));
      } else resolve();
    });
  });
}
