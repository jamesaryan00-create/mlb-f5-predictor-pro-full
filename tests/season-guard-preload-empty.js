// Preload (via NODE_OPTIONS=--require) that makes every MLB schedule fetch report zero games,
// simulating a genuinely gameless offseason day, without any real network call. Used by
// tests/season-guard-scripts.test.js to spawn the real cron scripts and confirm they skip
// cleanly and write no file under data/.
global.fetch = async () => ({ ok: true, json: async () => ({ dates: [] }) });
