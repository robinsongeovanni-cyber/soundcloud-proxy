// Minimal Express server to proxy SoundCloud search + progressive streams.
// Requires: express, node-fetch@2, dotenv
// Env: SOUNDCLOUD_CLIENT_ID

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2 (CommonJS). Install: npm i node-fetch@2
const { pipeline } = require('stream');
const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;

if (!CLIENT_ID) {
  console.error('Missing SOUNDCLOUD_CLIENT_ID environment variable.');
  process.exit(1);
}

app.use(express.json());
app.use(express.static('public')); // if you serve frontend from public/

// Simple CORS for development (adjust for production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten in prod
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Search tracks
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  try {
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${CLIENT_ID}&limit=20`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }
    const json = await upstream.json();
    res.json(json);
  } catch (err) {
    console.error('Search error', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Stream proxy by track ID (handles Range for seeking)
app.get('/api/stream/:id', async (req, res) => {
  const trackId = req.params.id;
  try {
    // Get track object
    const trackResp = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${CLIENT_ID}`);
    if (!trackResp.ok) {
      const text = await trackResp.text();
      return res.status(trackResp.status).send(text);
    }
    const track = await trackResp.json();

    // Find progressive transcoding
    const transcodings = (track.media && track.media.transcodings) || [];
    const progressive = transcodings.find(t => t.format && t.format.protocol === 'progressive');

    if (!progressive) {
      // Fall back: if there's an HLS transcoding, return redirect to stream URL (or client may use hls.js)
      const hls = transcodings.find(t => t.format && t.format.mime_type && t.format.mime_type.includes('mpeg'));
      if (hls) {
        const streamInfoResp = await fetch(`${hls.url}?client_id=${CLIENT_ID}`);
        const streamInfo = await streamInfoResp.json();
        return res.redirect(streamInfo.url);
      }
      return res.status(404).json({ error: 'No progressive stream available for this track' });
    }

    // Get actual stream URL from transcoding.url
    const streamInfoResp = await fetch(`${progressive.url}?client_id=${CLIENT_ID}`);
    if (!streamInfoResp.ok) {
      const text = await streamInfoResp.text();
      return res.status(streamInfoResp.status).send(text);
    }
    const streamInfo = await streamInfoResp.json();
    const streamUrl = streamInfo.url;
    if (!streamUrl) return res.status(500).json({ error: 'Unable to resolve stream URL' });

    // Forward Range header if present to allow seeking
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(streamUrl, { headers });
    // Forward a few headers and status
    res.status(upstream.status);
    const allowed = ['content-type', 'accept-ranges', 'content-length', 'content-range'];
    upstream.headers.forEach((value, name) => {
      if (allowed.includes(name)) res.setHeader(name, value);
    });

    // Stream the response body to the client
    const upstreamBody = upstream.body;
    if (!upstreamBody) {
      return res.status(500).json({ error: 'No body from upstream stream' });
    }
    pipeline(upstreamBody, res, err => {
      if (err) console.error('Stream pipeline error', err);
    });
  } catch (err) {
    console.error('Stream error', err);
    res.status(500).json({ error: 'Stream failed' });
  }
});

app.listen(PORT, () => {
  console.log(`SoundCloud proxy server listening on http://localhost:${PORT}`);
});
