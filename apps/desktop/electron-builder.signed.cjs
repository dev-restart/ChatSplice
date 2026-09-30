// Explicit opt-in: unsigned packaging continues to use electron-builder.yml.
/* global module, process */
module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: true,
  extraMetadata: { chatspliceUpdateChannel: 'stable' },
  mac: {
    identity: process.env.CSC_NAME || 'Developer ID Application',
    hardenedRuntime: true,
    notarize: true,
    // Config inheritance concatenates arrays; the base already supplies DMG.
    target: [{ target: 'zip', arch: ['arm64'] }],
  },
  publish: [
    { provider: 'github', owner: 'dev-restart', repo: 'ChatSplice', releaseType: 'release' },
  ],
};
