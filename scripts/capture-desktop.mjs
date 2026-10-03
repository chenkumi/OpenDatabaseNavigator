import { writeFile } from 'node:fs/promises';

// CDP screenshots can wait indefinitely for a compositor frame from a hidden
// Electron window. Electron's capture API explicitly wakes it without showing it.
export async function captureDesktop(desktop, path) {
  const encoded = await desktop.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const options = { stayHidden: true, stayAwake: true };
    // The first capture wakes a hidden compositor but may contain its old frame.
    await contents.capturePage(undefined, options);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await contents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (image.isEmpty()) throw new Error('Electron returned an empty screenshot.');
    return image.toPNG().toString('base64');
  });
  await writeFile(path, Buffer.from(encoded, 'base64'));
}
