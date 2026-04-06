// Netlify Serverless Function — fetches AI news RSS feeds server-side
// No CORS issues since this runs on Netlify's edge, not the browser

const FEEDS = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', label: 'TechCrunch' },
  { url: 'https://venturebeat.com/category/ai/feed/', label: 'VentureBeat' },
  { url: 'https://www.technologyreview.com/feed/', label: 'MIT Tech Review' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', label: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', label: 'Ars Technica' },
];

function extractTag(xml, tag) {
  // Handle CDATA
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'));
  if (cdataMatch) return cdataMatch[1].trim();
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractLink(itemXml) {
  // Try <link> tag (can be tricky in RSS)
  const guidMatch = itemXml.match(/<guid[^>]*isPermaLink="true"[^>]*>([^<]+)<\/guid>/i);
  if (guidMatch) return guidMatch[1].trim();
  const linkMatch = itemXml.match(/<link>([^<]+)<\/link>/i);
  if (linkMatch) return linkMatch[1].trim();
  // Atom style
  const atomMatch = itemXml.match(/<link[^>]+href="([^"]+)"/i);
  if (atomMatch) return atomMatch[1].trim();
  return '';
}

function parseFeed(xml, label) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractTag(item, 'title');
    const link = extractLink(item);
    const description = extractTag(item, 'description').substring(0, 300);
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'dc:date');
    if (title && link) {
      items.push({ title, link, description, pubDate, source: label });
    }
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'CSM-Integrated-News/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseFeed(text, feed.label);
  } catch (e) {
    console.warn(`Feed failed: ${feed.label}`, e.message);
    return [];
  }
}

export default async function handler(req, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900', // cache 15 min
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { headers: corsHeaders });
  }

  try {
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    let articles = [];
    results.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });

    // Filter to last 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const recent = articles.filter(a => {
      if (!a.pubDate) return true;
      const d = new Date(a.pubDate);
      return isNaN(d) || d >= cutoff;
    });

    // Sort newest first
    recent.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    // Deduplicate by title
    const seen = new Set();
    const deduped = recent.filter(a => {
      const key = a.title.toLowerCase().substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return new Response(JSON.stringify({ articles: deduped.slice(0, 20), fetched: new Date().toISOString() }), {
      headers: corsHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, articles: [] }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
