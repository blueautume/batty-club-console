export class ImageClipboardUnavailableError extends Error {
  constructor() { super('当前浏览器无法直接复制图片，请下载图片后发送'); this.name = 'ImageClipboardUnavailableError'; }
}

/** Start during the click event: Safari must receive the promise before user activation expires. */
export function copyPngToClipboard(image: Promise<Blob>): Promise<void> {
  if (!globalThis.isSecureContext || !globalThis.navigator?.clipboard?.write || typeof ClipboardItem === 'undefined' || (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png'))) {
    return Promise.reject(new ImageClipboardUnavailableError());
  }
  try { return navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); }
  catch (error) { return Promise.reject(error); }
}
