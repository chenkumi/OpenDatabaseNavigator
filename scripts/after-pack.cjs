const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

// Supported electron-builder afterPack hook. The AppImage stage subsequently
// copies appOutDir over its generated AppRun; the artifact checker verifies the
// actual embedded bytes, so a builder lifecycle change fails verification.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const config = context.packager.config;
  // This minimal launcher cannot implement an EULA acceptance workflow.
  // Never silently bypass one if a future release introduces that requirement.
  if (config.appImage?.license || config.linux?.license) {
    throw new Error('The minimal Linux AppRun does not support EULA acceptance.');
  }
  const launcher = await readFile(join(__dirname, 'linux-app-run.sh'));
  await writeFile(join(context.appOutDir, 'AppRun'), launcher, { mode: 0o755 });
};
