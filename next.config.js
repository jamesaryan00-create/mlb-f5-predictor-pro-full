/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API routes read data/*.json at runtime via fs.readdirSync + readFileSync loops
  // (e.g. lib/kalshi-results.js scanning data/kalshi-forward*). Next.js's build-time file
  // tracer can't statically determine which files a dynamic readdirSync loop will touch, so
  // by default it defensively bundles entire directories into the serverless function output.
  // Vercel serverless functions have a hard 250MB (uncompressed) size limit -- with this
  // project's data/ directory holding season-long backtest files, growing capture snapshots,
  // and point-in-time backups, that limit was very likely being exceeded, causing deployments
  // to fail. Explicitly exclude what a live request never needs: historical backups
  // (data/archive), and old/retired research data (kalshi-reconstructed, prospective -- also
  // already gitignored, excluded here too in case that ever changes).
  experimental: {
    outputFileTracingExcludes: {
      '*': [
        'data/archive/**',
        'data/kalshi-reconstructed/**',
        'data/prospective/**',
      ],
    },
  },
};

module.exports = nextConfig;
