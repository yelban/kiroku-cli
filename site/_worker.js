// Cloudflare Pages worker for kiroku.orz99.com
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // robots.txt
    if (url.pathname === '/robots.txt') {
      return new Response(
        'User-agent: *\nAllow: /\nSitemap: https://kiroku.orz99.com/sitemap.xml\n',
        { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' } }
      );
    }

    // sitemap.xml
    if (url.pathname === '/sitemap.xml') {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://kiroku.orz99.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`,
        { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' } }
      );
    }

    // Serve static assets
    const response = await env.ASSETS.fetch(request);

    // Add security headers
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};
