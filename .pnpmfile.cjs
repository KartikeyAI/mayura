/**
 * Isolate the legacy OpenAI SDK bundled by Stagehand 3 from the workspace's Zod 4.
 * OpenAI 4.104.0 declares an optional Zod ^3.23.8 peer; install that supported major
 * as its own real dependency instead. This changes ownership, not compatibility:
 * no unsupported peer range is accepted, and strict peer resolution stays enabled.
 * Stagehand and its optional Ollama transport can continue using supported Zod 4.
 * Remove this exact-version patch when Stagehand no longer brings OpenAI 4.104.0.
 */
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name !== 'openai' || pkg.version !== '4.104.0') return pkg;
      if (pkg.peerDependencies?.zod !== '^3.23.8') {
        throw new Error('The reviewed OpenAI 4 Zod dependency metadata changed.');
      }
      pkg.dependencies = { ...pkg.dependencies, zod: '3.25.76' };
      // A package-owned dependency replaces the consumer-supplied optional peer.
      delete pkg.peerDependencies.zod;
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.zod;
      return pkg;
    },
  },
};
