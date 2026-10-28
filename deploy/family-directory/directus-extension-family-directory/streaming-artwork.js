import path from 'node:path';

// Only generated JPEGs and the public manifest are addressable. No Jellyfin proxy.
export default function streamingArtwork(router) {
  router.get('/streaming-artwork/:file', (req, res) => {
    const file = req.params.file;
    if (file !== 'recent.json' && !/^[a-f0-9]{32}\.jpg$/.test(file)) return res.sendStatus(404);
    res.set('Cache-Control', file === 'recent.json' ? 'public, max-age=300' : 'public, max-age=86400, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(file === 'recent.json' ? 'json' : 'jpg');
    res.sendFile(path.join('/directus/uploads/streaming-artwork', file), err => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });
}
