// Netlify Serverless Function — fetches AI news RSS + og:images server-side

const FEEDS = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', label: 'TechCrunch' },
  { url: 'https://venturebeat.com/category/ai/feed/', label: 'VentureBeat' },
  { url: 'https://www.technologyreview.com/feed/', label: 'MIT Tech Review' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', label: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', label: 'Ars Technica' },
];

function extractTag(xml, tag) {
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'));
  if (cdataMatch) return cdataMatch[1].trim();
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractLink(itemXml) {
  const guidMatch = itemXml.match(/<guid[^>]*isPermaLink="true"[^>]*>([^<]+)<\/guid>/i);
  if (guidMatch) return guidMatch[1].trim();
  const linkMatch = itemXml.match(/<link>([^<]+)<\/link>/i);
  if (linkMatch) return linkMatch[1].trim();
  const atomMatch = itemXml.match(/<link[^>]+href="([^"]+)"/i);
  if (atomMatch) return atomMatch[1].trim();
  return '';
}

function extractRssImage(itemXml) {
  const mc = itemXml.match(/<media:content[^>]+url="([^"]+)"/i);
  if (mc && /\.(jpg|jpeg|png|webp)/i.test(mc[1])) return mc[1];
  const mt = itemXml.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
  if (mt) return mt[1];
  const enc = itemXml.match(/<enclosure[^>]+type="image\/[^"]*"[^>]+url="([^"]+)"/i)
    || itemXml.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image\/[^"]*"/i);
  if (enc) return enc[1];
  const cdata = itemXml.match(/<content:encoded[^>]*><!?\[CDATA\[([\s\S]*?)\]\]>/i)
    || itemXml.match(/<description[^>]*><!?\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdata) {
    const img = cdata[1].match(/<img[^>]+src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i);
    if (img) return img[1];
  }
  return null;
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
    const image = extractRssImage(item);
    if (title && link) {
      items.push({ title, link, description, pubDate, source: label, image });
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

async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CSMBot/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 8000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel();
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && ogMatch[1].startsWith('http')) return ogMatch[1];
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch && twMatch[1].startsWith('http')) return twMatch[1];
    return null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900',
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { headers: corsHeaders });
  }

  try {
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    let articles = [];
    results.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    articles = articles.filter(a => {
      if (!a.pubDate) return true;
      const d = new Date(a.pubDate);
      return isNaN(d) || d >= cutoff;
    });
    articles.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const seen = new Set();
    articles = articles.filter(a => {
      const key = a.title.toLowerCase().substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);

    // Fetch og:image for articles missing images (first 12 only, concurrently)
    const imageJobs = articles.slice(0, 12).map(async (article, i) => {
      if (article.image) return;
      const img = await fetchOgImage(article.link);
      if (img) articles[i].image = img;
    });
    await Promise.allSettled(imageJobs);

    return new Response(JSON.stringify({ articles, fetched: new Date().toISOString() }), {
      headers: corsHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, articles: [] }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
